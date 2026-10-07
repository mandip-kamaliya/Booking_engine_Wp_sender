import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseBooking, route, preview } from './booking.js';
import { readFileSync } from 'node:fs';

const env=process.env;
const locations=JSON.parse(readFileSync('config/locations.json','utf8'));
const auth={user:env.IMAP_USER};
if (env.IMAP_ACCESS_TOKEN) auth.accessToken=env.IMAP_ACCESS_TOKEN;
else auth.pass=env.IMAP_PASSWORD?.replace(/\s/g,'');
if (!env.IMAP_HOST || !auth.user || !(auth.pass || auth.accessToken)) throw new Error('Mailbox credentials are incomplete.');
const client=new ImapFlow({host:env.IMAP_HOST,port:993,secure:true,auth,logger:false});
await client.connect();
try {
  const lock=await client.getMailboxLock(env.IMAP_MAILBOX || 'INBOX');
  try {
    const total=client.mailbox.exists; let latest;
    for await (const msg of client.fetch(`${Math.max(1,total-49)}:*`,{uid:true,envelope:true,internalDate:true})) {
      if (msg.envelope.subject?.trim().toLowerCase()==='booking confirmed' && (!latest || msg.uid>latest.uid)) latest=msg;
    }
    if (!latest) throw new Error('No Booking Confirmed email in latest 50 Inbox messages.');
    const full=await client.fetchOne(latest.uid,{source:true},{uid:true});
    if (!full?.source) throw new Error('Could not read the booking email source.');
    const mail=await simpleParser(full.source);
    const b=await parseBooking(full.source);
    const l=route(b.address,locations);
    const authHeaders=mail.headerLines.filter(h=>h.key==='authentication-results').map(h=>h.line);
    const receivedHeaders=mail.headerLines.filter(h=>h.key==='received').slice(0,2).map(h=>h.line);
    console.log(JSON.stringify({uid:latest.uid,received:latest.internalDate.toISOString(),from:mail.from?.text,replyTo:mail.replyTo?.text,authenticationResults:authHeaders,receivedHeaders,location:l.id,sender:l.sender,template:l.template,bookingId:b.bookingId,routesToApprovedTemplate:l.approved,messagePreview:preview(b,l)},null,2));
  } finally {lock.release();}
} finally {await client.logout();}
