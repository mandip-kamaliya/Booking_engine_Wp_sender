import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBooking,route,payload } from '../src/booking.js';
import { database,processEmail,send,recordDeliveryReport } from '../src/service.js';
const locations=JSON.parse(readFileSync('config/locations.json','utf8'));
function email(address='Time 09 Am to 5 Pm, Nagaon - Alibaug, Raigad-402204') {
  return Buffer.from(`From: enquiry@entartica.com\r\nSubject: Booking Confirmed\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<table><tr><td>Booking ID: <span>#449</span><br>Guest Name: TEST GUEST</td><td>Mobile No: +91 98765 43210<br>Email-Id: test@example.com</td></tr><tr><td>Amount Paid</td><td>: ₹3,000.00</td></tr></table><table><tr><th>Pass Name</th><th>No Of Person</th><th>Visit Date</th><th>Staff Member</th></tr><tr><td>Ferrari Car</td><td>3</td><td>October 10, 2026</td><td>Test</td></tr></table><table><tr><td>Inclusions</td></tr><!-- Raipur Coimbatore template comments --><tr><td></td></tr><tr><td>Life jackets &amp; supervision</td></tr><tr><td>15 minute ride</td></tr></table><table><tr><td>Attractions</td></tr></table><table><tr><td>Time &amp; Address: ${address}<br>© 2026 Entartica</td></tr></table>`);
}
test('extracts all inclusions and routes only using footer',async()=>{
  const b=await parseBooking(email());assert.equal(b.phone,'919876543210');assert.equal(b.name,'TEST GUEST');assert.equal(b.inclusions,'Life jackets & supervision | 15 minute ride');assert.equal(b.rides[0].guests,'3');assert.equal(route(b.address,locations).id,'alibaug');assert.ok(!b.address.includes('©'));
});
test('all mapped branches resolve and generic/ambiguous addresses fail',()=>{
  for(const l of locations) assert.equal(route(`Entartica ${l.aliases[0]}`,locations).id,l.id);
  assert.throws(()=>route('Alibaug and Coimbatore',locations));assert.throws(()=>route('Entartica Sea World',locations));
});
test('unmapped Alibaug sender cannot generate send payload',async()=>{const b=await parseBooking(email());assert.throws(()=>payload(b,locations[0]),/sender/);});
test('invalid recipient and missing inclusions are rejected',async()=>{
  await assert.rejects(parseBooking(Buffer.from(email().toString().replace('+91 98765 43210','unknown'))));
  await assert.rejects(parseBooking(Buffer.from(email().toString().replace('Inclusions','Missing'))));
});
test('preview cannot send and duplicate email sends only once in live mode',async()=>{
  const db=database(':memory:');const ls=locations.map(l=>({...l,sender:l.sender||'917948502801',approved:true}));
  const env={SEND_ENABLED:'true',TRUSTED_AUTHSERV_ID:'mx.google.com',PROCESS_AFTER:'2026-10-05T00:00:00Z',EXOTEL_HOST:'api.in.exotel.com',EXOTEL_ACCOUNT_SID:'test',EXOTEL_API_KEY:'test',EXOTEL_API_TOKEN:'test'};
  let calls=0;const fake=async()=>{calls++;return {ok:true,json:async()=>({response:{whatsapp:{messages:[{status:'success',data:{sid:'test-sid'}}]}}})};};
  assert.equal(await processEmail(email(),ls,db,{},fake),'preview');assert.equal(calls,0);
  const signed=Buffer.concat([Buffer.from('Authentication-Results: mx.google.com; dmarc=pass header.from=entartica.com\r\n'),email()]);
  assert.equal(await processEmail(signed,ls,db,env,fake),'accepted');
  assert.equal(await processEmail(signed,ls,db,env,fake),'duplicate');assert.equal(calls,1);db.close();
});
test('timeouts are held as uncertain and never blindly retried',async()=>{
  const db=database(':memory:');const ls=locations.map(l=>({...l,sender:l.sender||'917948502801',approved:true}));
  const env={SEND_ENABLED:'true',TRUSTED_AUTHSERV_ID:'mx.google.com',PROCESS_AFTER:'2026-10-05T00:00:00Z',EXOTEL_HOST:'api.in.exotel.com',EXOTEL_ACCOUNT_SID:'test',EXOTEL_API_KEY:'test',EXOTEL_API_TOKEN:'test'};
  const fail=async()=>{throw new Error('timeout')};
  const signed=Buffer.concat([Buffer.from('Authentication-Results: mx.google.com; dmarc=pass header.from=entartica.com\r\n'),email()]);
  assert.equal(await processEmail(signed,ls,db,env,fail),'uncertain');assert.equal(await processEmail(signed,ls,db,env,fail),'duplicate');db.close();
});
test('HTTP success with per-message failure is rejected',async()=>{
  const provider={host:'api.in.exotel.com',accountSid:'test',apiKey:'key',apiToken:'token'};
  await assert.rejects(send({},provider,{},async()=>({ok:true,json:async()=>({response:{whatsapp:{messages:[{status:'failed'}]}}})})));
});
test('delivery callback URL is included only when its secret matches',async()=>{
  let received;
  const body={whatsapp:{messages:[]}};
  const provider={host:'api.exotel.com',accountSid:'test',apiKey:'key',apiToken:'token'};
  const env={STATUS_CALLBACK_URL:'https://example.test/exotel/status?token=secret',CALLBACK_SECRET:'secret'};
  await send(body,provider,env,async(_url,options)=>{received=JSON.parse(options.body);return {ok:true,json:async()=>({response:{whatsapp:{messages:[{status:'success',data:{sid:'test-sid'}}]}}})};});
  assert.equal(received.status_callback,env.STATUS_CALLBACK_URL);
  await assert.rejects(send(body,provider,{...env,CALLBACK_SECRET:'wrong'},async()=>{}),/Callback/);
});
test('delivery reports are recorded by message SID',()=>{
  const db=database(':memory:');
  recordDeliveryReport(db,{whatsapp:{messages:[{sid:'message-1',custom_data:'rajsamand:450',exo_status_code:30002,exo_detailed_status:'EX_MESSAGE_DELIVERED',description:'Message delivered'}]}});
  const report=db.prepare('SELECT booking_key,status_code,status FROM delivery_reports WHERE sid=?').get('message-1');
  assert.equal(report.booking_key,'rajsamand:450');assert.equal(report.status_code,30002);assert.equal(report.status,'EX_MESSAGE_DELIVERED');db.close();
});
test('oversized inclusions are held without truncation',async()=>{
  const b=await parseBooking(email());b.inclusions='Included service '.repeat(100);
  assert.throws(()=>payload(b,{...locations[0],sender:'917948502801'}),/1024/);
});
test('live mail without receiving-server authentication never sends',async()=>{
  const db=database(':memory:');let calls=0;
  const env={SEND_ENABLED:'true',TRUSTED_AUTHSERV_ID:'mx.google.com',PROCESS_AFTER:'2026-10-05T00:00:00Z',EXOTEL_HOST:'api.in.exotel.com',EXOTEL_ACCOUNT_SID:'test',EXOTEL_API_KEY:'test',EXOTEL_API_TOKEN:'test'};
  assert.equal(await processEmail(email(),locations,db,env,async()=>{calls++;}),'held');assert.equal(calls,0);db.close();
});
test('test recipient guard holds bookings for everyone else',async()=>{
  const db=database(':memory:'); const ls=locations.map(l=>({...l,sender:l.sender||'917948502801',approved:true})); let calls=0;
  const env={SEND_ENABLED:'true',TEST_RECIPIENT:'919999999999',TRUSTED_AUTHSERV_ID:'mx.google.com',PROCESS_AFTER:'2026-10-05T00:00:00Z',EXOTEL_HOST:'api.in.exotel.com',EXOTEL_ACCOUNT_SID:'test',EXOTEL_API_KEY:'test',EXOTEL_API_TOKEN:'test'};
  const signed=Buffer.concat([Buffer.from('Authentication-Results: mx.google.com; dmarc=pass header.from=entartica.com\r\n'),email()]);
  assert.equal(await processEmail(signed,ls,db,env,async()=>{calls++;}),'held'); assert.equal(calls,0); db.close();
});
test('test booking guard holds other booking IDs',async()=>{
  const db=database(':memory:'); const ls=locations.map(l=>({...l,sender:l.sender||'917948502801',approved:true})); let calls=0;
  const env={SEND_ENABLED:'true',TEST_BOOKING_ID:'451',TRUSTED_AUTHSERV_ID:'mx.google.com',PROCESS_AFTER:'2026-10-05T00:00:00Z',EXOTEL_HOST:'api.in.exotel.com',EXOTEL_ACCOUNT_SID:'test',EXOTEL_API_KEY:'test',EXOTEL_API_TOKEN:'test'};
  const signed=Buffer.concat([Buffer.from('Authentication-Results: mx.google.com; dmarc=pass header.from=entartica.com\r\n'),email()]);
  assert.equal(await processEmail(signed,ls,db,env,async()=>{calls++;}),'held'); assert.equal(calls,0); db.close();
});
test('explicit test booking can proceed when Gmail omits authentication results',async()=>{
  const db=database(':memory:');const ls=locations.map(l=>({...l,sender:l.sender||'917948502801',approved:true}));let calls=0;
  const env={SEND_ENABLED:'true',TEST_BOOKING_ID:'449',TRUSTED_AUTHSERV_ID:'mx.google.com',PROCESS_AFTER:'2026-10-05T00:00:00Z',EXOTEL_HOST:'api.in.exotel.com',EXOTEL_ACCOUNT_SID:'test',EXOTEL_API_KEY:'test',EXOTEL_API_TOKEN:'test'};
  const result=await processEmail(email(),ls,db,env,async()=>{calls++;return {ok:true,json:async()=>({response:{whatsapp:{messages:[{status:'success',data:{sid:'test-sid'}}]}}})};});
  assert.equal(result,'accepted');assert.equal(calls,1);db.close();
});
test('Gmail internal REST receipt is trusted for production bookings',async()=>{
  const db=database(':memory:');const ls=locations.map(l=>({...l,sender:l.sender||'917948502801',approved:true}));let calls=0;
  const env={SEND_ENABLED:'true',TRUSTED_AUTHSERV_ID:'mx.google.com',PROCESS_AFTER:'2026-10-05T00:00:00Z',EXOTEL_HOST:'api.in.exotel.com',EXOTEL_ACCOUNT_SID:'test',EXOTEL_API_KEY:'test',EXOTEL_API_TOKEN:'test'};
  const internal=Buffer.concat([Buffer.from('Received: from internal by gmailapi.google.com with HTTPREST;\r\n'),email()]);
  const result=await processEmail(internal,ls,db,env,async()=>{calls++;return {ok:true,json:async()=>({response:{whatsapp:{messages:[{status:'success',data:{sid:'test-sid'}}]}}})};});
  assert.equal(result,'accepted');assert.equal(calls,1);db.close();
});
test('multiple ride rows are preserved',async()=>{
  const raw=email().toString().replace('<td>Test</td></tr>','<td>Test</td></tr><tr><td>Boat Ride</td><td>2</td><td>October 11, 2026</td><td>Staff</td></tr>');
  const b=await parseBooking(Buffer.from(raw));assert.equal(b.rides.length,2);assert.equal(b.rides[1].name,'Boat Ride');
});
