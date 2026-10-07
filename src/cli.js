import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { parseBooking, route, preview, payload } from './booking.js';
import { database, processEmail, validateLive } from './service.js';

const locations=JSON.parse(readFileSync('config/locations.json','utf8'));
const [command,arg]=process.argv.slice(2);
const env=process.env;
async function poll(db) {
  const auth={user:env.IMAP_USER};
  if (env.IMAP_ACCESS_TOKEN) auth.accessToken=env.IMAP_ACCESS_TOKEN;
  else auth.pass=env.IMAP_PASSWORD?.replace(/\s/g,'');
  if (!env.IMAP_HOST || !auth.user || !(auth.pass || auth.accessToken)) throw new Error('Configure mailbox credentials in .env');
  const client=new ImapFlow({host:env.IMAP_HOST,port:993,secure:true,auth,logger:false});
  await client.connect();
  try {
    const lock=await client.getMailboxLock(env.IMAP_MAILBOX || 'INBOX');
    try {
      const ns=`${env.IMAP_HOST}:${env.IMAP_USER}:${env.IMAP_MAILBOX || 'INBOX'}:${client.mailbox.uidValidity}:${env.SEND_ENABLED==='true'?'live':'preview'}`;
      let since=db.prepare('SELECT value FROM settings WHERE key=?').get(ns)?.value;
      // First run starts now unless an explicit cutoff was supplied. Never replay all old bookings.
      if (!since) {since=env.PROCESS_AFTER || new Date().toISOString();db.prepare('INSERT INTO settings VALUES(?,?)').run(ns,since);}
      const start=Date.parse(since);
      if (!Number.isFinite(start)) throw new Error('Invalid mailbox start timestamp');
      const ids=await client.search({since:new Date(start),from:'enquiry@entartica.com',subject:'Booking Confirmed'},{uid:true});
      for (const uid of ids || []) {
        const seenKey=`${ns}:uid:${uid}`;
        const previous=db.prepare('SELECT value FROM settings WHERE key=?').get(seenKey)?.value;
        if (previous && !(previous==='held' && env.RETRY_HELD==='true')) continue;
        const item=await client.fetchOne(uid,{source:true,internalDate:true},{uid:true});
        if (!item || new Date(item.internalDate).getTime()<start) continue;
        const result=await processEmail(item.source,locations,db,env);
        db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(seenKey,result);
        console.log(`Mail UID ${uid}: ${result}`);
      }
    } finally {lock.release();}
  } finally {await client.logout();}
}
try {
  if (command==='preview') {
    if (!arg) throw new Error('Usage: npm run preview -- "path/to/booking.eml"');
    const b=await parseBooking(readFileSync(arg));const l=route(b.address,locations);
    let api=null,hold=null;try {api=payload(b,l);}catch(e){hold=e.message;}
    console.log(JSON.stringify({location:l.id,sender:l.sender,hold,booking:b,message:preview(b,l),payload:api},null,2));
  } else if (command==='status') {
    const db=database();console.table(db.prepare('SELECT * FROM jobs ORDER BY updated DESC LIMIT 100').all());console.table(db.prepare('SELECT sid,booking_key,status_code,status,description,received FROM delivery_reports ORDER BY received DESC LIMIT 100').all());db.close();
  } else if (command==='watch' || command==='once') {
    if (env.SEND_ENABLED==='true') validateLive(env);
    const db=database();
    do {
      try {await poll(db);}catch(e){console.error(`Mailbox run failed: ${e.message}`);if(command==='once')throw e;}
      if(command==='watch') await new Promise(r=>setTimeout(r,Math.max(10,Number(env.POLL_SECONDS)||60)*1000));
    } while(command==='watch');
    db.close();
  } else throw new Error('Commands: preview <file.eml>, watch, once, status');
} catch(e) {console.error(e.message);process.exitCode=1;}
