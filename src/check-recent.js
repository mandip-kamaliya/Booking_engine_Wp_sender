import { ImapFlow } from 'imapflow';

const env=process.env;
const auth={user:env.IMAP_USER};
if (env.IMAP_ACCESS_TOKEN) auth.accessToken=env.IMAP_ACCESS_TOKEN;
else auth.pass=env.IMAP_PASSWORD?.replace(/\s/g,'');
if (!env.IMAP_HOST || !auth.user || !(auth.pass || auth.accessToken)) throw new Error('Mailbox credentials are incomplete.');
const client=new ImapFlow({host:env.IMAP_HOST,port:993,secure:true,auth,logger:false});
await client.connect();
try {
  const lock=await client.getMailboxLock(env.IMAP_MAILBOX || 'INBOX');
  try {
    const total=client.mailbox.exists;
    const start=Math.max(1,total-24);
    const found=[];
    for await (const msg of client.fetch(`${start}:*`,{uid:true,envelope:true,internalDate:true})) {
      if (msg.envelope.subject?.trim().toLowerCase()==='booking confirmed') found.push({uid:msg.uid,received:msg.internalDate.toISOString(),subject:msg.envelope.subject});
    }
    console.log(JSON.stringify({mailbox:env.IMAP_MAILBOX || 'INBOX',recentMessagesChecked:total-start+1,bookingConfirmedMatches:found},null,2));
  } finally {lock.release();}
} finally {await client.logout();}
