// Explicit, audited resend for a known booking email. This never runs from the watcher.
import { ImapFlow } from 'imapflow';
import { readFileSync } from 'node:fs';
import { parseBooking, route, payload } from './booking.js';
import { database, send, validateLive, providerFor } from './service.js';

const [uidText,bookingId]=process.argv.slice(2);
const uid=Number(uidText); const env=process.env;
if (!Number.isInteger(uid) || uid<1 || !bookingId) throw new Error('Usage: resend <imap-uid> <booking-id>');
validateLive(env);
const locations=JSON.parse(readFileSync('config/locations.json','utf8'));
const auth={user:env.IMAP_USER,pass:env.IMAP_PASSWORD?.replace(/\s/g,'')};
const client=new ImapFlow({host:env.IMAP_HOST,port:993,secure:true,auth,logger:false});
await client.connect();
try {
  const lock=await client.getMailboxLock(env.IMAP_MAILBOX || 'INBOX');
  try {
    const message=await client.fetchOne(uid,{source:true},{uid:true});
    if (!message?.source) throw new Error('Booking email UID was not found.');
    const booking=await parseBooking(message.source);
    if (booking.bookingId!==bookingId) throw new Error('Booking ID does not match the selected email.');
    const location=route(booking.address,locations);
    if (!location.approved) throw new Error('Location template is not approved.');
    const db=database();
    const key=`manual:${location.id}:${booking.bookingId}:${Date.now()}`;
    db.prepare('INSERT INTO jobs(key,state,detail) VALUES(?,?,?)').run(key,'sending','Explicit callback-enabled re-test');
    try {const sid=await send(payload(booking,location),providerFor(location,env),env);db.prepare('UPDATE jobs SET state=?,detail=?,updated=CURRENT_TIMESTAMP WHERE key=?').run('accepted',sid,key);console.log(`Accepted by Exotel; SID ${sid}`);}
    catch (error) {db.prepare('UPDATE jobs SET state=?,detail=?,updated=CURRENT_TIMESTAMP WHERE key=?').run('uncertain',error.message,key);throw error;}
    finally {db.close();}
  } finally {lock.release();}
} finally {await client.logout();}
