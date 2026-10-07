import { simpleParser } from 'mailparser';
import { load } from 'cheerio';

export const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export function route(address, locations) {
  const hits = locations.filter(l => l.aliases.some(a => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(address)));
  if (hits.length !== 1) throw new Error('Address has unknown or ambiguous location');
  return hits[0];
}
export async function parseBooking(raw) {
  const mail = await simpleParser(raw);
  if (clean(mail.subject).toLowerCase() !== 'booking confirmed') throw new Error('Unexpected subject');
  if (mail.from?.value?.length !== 1 || mail.from.value[0].address.toLowerCase() !== 'enquiry@entartica.com') throw new Error('Unexpected sender');
  if (!mail.html) throw new Error('Expected HTML booking email');
  const $ = load(mail.html);
  $('script,style').remove();
  $('br').replaceWith('\n');
  // Leaf cells only: parent layout tables repeat all nested content.
  const cells = $('td').toArray().filter(e => !$(e).find('td').length).map(e => clean($(e).text()));
  const text = cells.join('\n');
  const get = re => {const m = text.match(re); if (!m) throw new Error(`Missing booking field: ${re.source}`); return clean(m[1]);};
  const bookingId = get(/Booking ID:\s*#?([\w-]+)/i);
  const name = get(/Guest Name:\s*(.+)/i);
  const phone = get(/Mobile No:\s*(.*?)\s*Email-Id:/i).replace(/[\s()+-]/g, '');
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('Mobile number must include country code');
  const addressCells = cells.filter(c => /^Time\s*&\s*Address\s*:/i.test(c));
  if (addressCells.length !== 1) throw new Error('Missing or multiple footer addresses');
  const address = clean(addressCells[0].replace(/^Time\s*&\s*Address\s*:/i, '').split('©')[0]);
  if (!address) throw new Error('Empty address');
  const start = cells.findIndex(c => c === 'Inclusions');
  const end = cells.findIndex((c,i) => i > start && c === 'Attractions');
  if (start < 0 || end < 0) throw new Error('Missing inclusions section boundaries');
  const inclusions = [...new Set(cells.slice(start+1,end).filter(Boolean))].join(' | ');
  if (!inclusions) throw new Error('Missing inclusions');
  const rides = [];
  $('table').each((_,table) => {
    if ($(table).find('table').length) return;
    const rows = $(table).find('tr').toArray();
    const headers = $(rows[0]).find('th').toArray().map(e=>clean($(e).text()));
    if (!headers.includes('Pass Name')) return;
    for (const row of rows.slice(1)) {
      const values = $(row).children('td').toArray().map(e=>clean($(e).text()));
      const ride = {name:values[headers.indexOf('Pass Name')], guests:values[headers.findIndex(h=>/^No Of Person$/i.test(h))], date:values[headers.indexOf('Visit Date')]};
      if (!ride.name || !/^\d+$/.test(ride.guests) || Number(ride.guests)<1 || !ride.date) throw new Error('Invalid ride row');
      rides.push(ride);
    }
  });
  if (!rides.length) throw new Error('Missing rides');
  const amountIndex = cells.findIndex(c=>c === 'Amount Paid');
  const amount = amountIndex >= 0 ? clean(cells[amountIndex+1]).replace(/^:\s*/, '') : '';
  if (!/^₹[\d,]+(?:\.\d{2})?$/.test(amount)) throw new Error('Invalid amount');
  return {bookingId,name,phone,address,inclusions,rides,amount};
}
export function parameters(b,l) {
  return [b.name,l.name,b.bookingId,b.rides.map(r=>`${r.name} — ${r.guests} guest(s) — ${r.date}`).join(' | '),b.amount,b.address,b.inclusions];
}
export function preview(b,l) {
  const p = parameters(b,l);
  return `Hi ${p[0]}, your booking at ${p[1]} is confirmed!\nBooking ID: #${p[2]}\nRide details: ${p[3]}\nAmount paid: ${p[4]}\nTime & address: ${p[5]}\nInclusions: ${p[6]}\nPlease check your confirmation email for full details.`;
}
export function payload(b,l) {
  if (!/^\d{8,15}$/.test(l.sender ?? '')) throw new Error('Location sender is not configured');
  // Fail closed instead of silently omitting inclusions from oversized messages.
  if (preview(b,l).length > 1024) throw new Error('Message exceeds conservative 1024-character limit; review template');
  return {custom_data:`${l.id}:${b.bookingId}`,whatsapp:{messages:[{from:l.sender,to:b.phone,content:{type:'template',template:{name:l.template,language:{policy:'deterministic',code:l.language},components:[{type:'body',parameters:parameters(b,l).map(text=>({type:'text',text}))}]}}}]}};
}
