import { ImapFlow } from 'imapflow';

// Read-only connectivity check: never fetches emails or sends WhatsApp messages.
const env=process.env;
const auth={user:env.IMAP_USER};
if(env.IMAP_ACCESS_TOKEN) auth.accessToken=env.IMAP_ACCESS_TOKEN;
else auth.pass=env.IMAP_PASSWORD?.replace(/\s/g,'');
if(!env.IMAP_HOST || !auth.user || !(auth.pass || auth.accessToken)) {
  console.error('Fill IMAP_HOST, IMAP_USER and IMAP_PASSWORD (app password) or IMAP_ACCESS_TOKEN in .env.');
  process.exitCode=1;
} else {
  const client=new ImapFlow({host:env.IMAP_HOST,port:993,secure:true,auth,logger:false});
  try {
    await client.connect();
    const info=await client.status(env.IMAP_MAILBOX || 'INBOX',{messages:true});
    console.log(`Gmail connection successful. Mail folder available (${info.messages} messages). No email processed or WhatsApp sent.`);
  } catch {
    console.error('Mailbox connection failed. Check app password/OAuth, account IMAP policy, and network access.');
    process.exitCode=1;
  } finally {if(client.usable) await client.logout();else client.close();}
}
