import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseBooking, route, payload } from './booking.js';
import { simpleParser } from 'mailparser';

export function database(path='data/state.sqlite') {
  mkdirSync('data',{recursive:true});
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT, updated TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_reports (
      sid TEXT PRIMARY KEY, booking_key TEXT, status_code INTEGER, status TEXT,
      description TEXT, received TEXT DEFAULT CURRENT_TIMESTAMP, payload TEXT NOT NULL
    );`);
  return db;
}
export function update(db,key,state,detail='') {
  db.prepare('UPDATE jobs SET state=?,detail=?,updated=CURRENT_TIMESTAMP WHERE key=?').run(state,detail,key);
}
export function validateLive(env) {
  if (!env.TRUSTED_AUTHSERV_ID) throw new Error('Missing TRUSTED_AUTHSERV_ID');
  if (env.PROCESS_AFTER && !Number.isFinite(Date.parse(env.PROCESS_AFTER))) throw new Error('Invalid PROCESS_AFTER');
}
export function providerFor(location,env) {
  const suffix=location.credentialKey ? `_${location.credentialKey}` : '';
  const get=name => env[`EXOTEL${suffix}_${name}`] || env[`EXOTEL_${name}`];
  const provider={host:get('HOST'),accountSid:get('ACCOUNT_SID'),apiKey:get('API_KEY'),apiToken:get('API_TOKEN')};
  for (const [key,value] of Object.entries(provider)) if (!value) throw new Error(`Missing Exotel ${key} for ${location.id}`);
  if (!['api.exotel.com','api.in.exotel.com'].includes(provider.host)) throw new Error(`Invalid Exotel host for ${location.id}`);
  return provider;
}
export function callbackUrl(env) {
  if (env.STATUS_CALLBACK_URL) return env.STATUS_CALLBACK_URL;
  const base=env.PUBLIC_BASE_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  return base ? `${base.replace(/\/$/,'')}/exotel/status?token=${encodeURIComponent(env.CALLBACK_SECRET || '')}` : '';
}
export async function send(body,provider,env,fetcher=fetch) {
  const request={...body};
  const callbackUrlValue=callbackUrl(env);
  if (callbackUrlValue) {
    let callback;
    try { callback=new URL(callbackUrlValue); } catch { throw new Error('Invalid status callback URL'); }
    if (callback.protocol!=='https:' || !env.CALLBACK_SECRET || callback.searchParams.get('token')!==env.CALLBACK_SECRET) throw new Error('Callback must be HTTPS and include CALLBACK_SECRET as its token parameter');
    request.status_callback=callback.toString();
  }
  const url = `https://${provider.host}/v2/accounts/${encodeURIComponent(provider.accountSid)}/messages`;
  const res = await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:`Basic ${Buffer.from(`${provider.apiKey}:${provider.apiToken}`).toString('base64')}`},body:JSON.stringify(request)});
  if (!res.ok) throw new Error(`Exotel HTTP ${res.status}; check provider logs before retrying`);
  const data = await res.json();
  const msg = data.response?.whatsapp?.messages?.[0];
  if (msg?.status !== 'success' || !msg.data?.sid) throw new Error('Exotel did not confirm message acceptance');
  return msg.data.sid;
}
export function recordDeliveryReport(db, body) {
  const messages=body?.whatsapp?.messages;
  if (!Array.isArray(messages) || messages.length===0 || messages.length>100) throw new Error('Invalid delivery report');
  const insert=db.prepare('INSERT INTO delivery_reports(sid,booking_key,status_code,status,description,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(sid) DO UPDATE SET status_code=excluded.status_code,status=excluded.status,description=excluded.description,received=CURRENT_TIMESTAMP,payload=excluded.payload');
  for (const message of messages) {
    if (typeof message.sid!=='string' || !message.sid || message.sid.length>200) throw new Error('Invalid delivery report SID');
    const code=Number.isInteger(message.exo_status_code) ? message.exo_status_code : null;
    insert.run(message.sid,typeof message.custom_data==='string' ? message.custom_data.slice(0,200) : null,code,typeof message.exo_detailed_status==='string' ? message.exo_detailed_status.slice(0,200) : null,typeof message.description==='string' ? message.description.slice(0,500) : null,JSON.stringify(message));
  }
}
export async function processEmail(raw,locations,db,env,fetcher=fetch) {
  const live = env.SEND_ENABLED === 'true';
  let b,l,body;
  const sourceKey = `${live?'live':'preview'}:source:${createHash('sha256').update(raw).digest('hex')}`;
  const earlier=db.prepare('SELECT state FROM jobs WHERE key=?').get(sourceKey);
  if (earlier && !(earlier.state==='held' && env.RETRY_HELD==='true')) return earlier.state==='held' ? 'held' : 'duplicate';
  try {
    let authTrusted=false;
    if (live) {
      validateLive(env);
      const mail=await simpleParser(raw);
      // Trust only the receiving provider's first Authentication-Results header.
      // Mail provider must strip forged headers claiming its own authserv-id.
      const header=mail.headerLines.find(h=>h.key==='authentication-results')?.line || '';
      const value=header.replace(/^Authentication-Results:\s*/i,'').replace(/\s+/g,' ');
      const dmarcTrusted=value.split(';')[0].trim()===env.TRUSTED_AUTHSERV_ID && /\bdmarc=pass\b[^;]*\bheader\.from=entartica\.com(?=[\s;]|$)/i.test(value);
      // WordPress sends these confirmations through the same Gmail account.
      // Gmail's internal HTTP REST deliveries have no Authentication-Results,
      // but prepend this provider-generated first Received header.
      const firstReceived=mail.headerLines.find(h=>h.key==='received')?.line || '';
      const gmailInternal=/^Received:.*\bby gmailapi\.google\.com\b[\s\S]*\bwith HTTPREST;/i.test(firstReceived);
      authTrusted=dmarcTrusted || gmailInternal;
    }
    b=await parseBooking(raw); l=route(b.address,locations);
    const testRecipient=(env.TEST_RECIPIENT || '').replace(/\D/g,'');
    if (testRecipient && b.phone !== testRecipient) throw new Error('Test mode: recipient does not match TEST_RECIPIENT');
    if (env.TEST_BOOKING_ID && b.bookingId !== env.TEST_BOOKING_ID) throw new Error('Test mode: booking ID does not match TEST_BOOKING_ID');
    // The test bypass is limited to one explicit booking. Regular production
    // mail must pass DMARC or use Gmail's internal provider receipt above.
    if (live && !authTrusted && !env.TEST_BOOKING_ID) throw new Error('Mailbox authentication missing or untrusted; review email');
    body=payload(b,l);
  }
  catch(e) {
    db.prepare('INSERT OR IGNORE INTO jobs(key,state,detail) VALUES(?,?,?)').run(sourceKey,'held',e.message);
    return 'held';
  }
  const key = `${live?'live':'preview'}:${l.id}:${b.bookingId}`;
  if (live) validateLive(env);
  // A durable reservation prevents duplicate sends on repeated emails or concurrent workers.
  const claim = db.prepare('INSERT OR IGNORE INTO jobs(key,state,detail) VALUES(?,?,?)').run(key,'reserved','');
  if (!claim.changes) return 'duplicate';
  if (!live) {update(db,key,'preview','Validated; no API request made'); return 'preview';}
  if (!l.approved) {update(db,key,'held','Template approval must be configured');return 'held';}
  update(db,key,'sending');
  try {const sid=await send(body,providerFor(l,env),env,fetcher);update(db,key,'accepted',sid);return 'accepted';}
  catch(e) {update(db,key,'uncertain',e.message);return 'uncertain';}
}
