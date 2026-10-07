import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { database, recordDeliveryReport } from './service.js';

const env=process.env;
const port=Number(env.PORT || env.CALLBACK_PORT || 8787);
if (!Number.isInteger(port) || port<1024 || port>65535 || !env.CALLBACK_SECRET) throw new Error('Set CALLBACK_PORT and CALLBACK_SECRET.');
const secret=Buffer.from(env.CALLBACK_SECRET);
const matches=value => {const supplied=Buffer.from(value || '');return supplied.length===secret.length && timingSafeEqual(supplied,secret);};
const db=database();
const server=createServer((req,res) => {
  const url=new URL(req.url,`http://${req.headers.host || 'localhost'}`);
  if (req.method!=='POST' || url.pathname!=='/exotel/status' || !matches(url.searchParams.get('token'))) {res.writeHead(404).end();return;}
  let size=0,raw='';
  req.setEncoding('utf8');
  req.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size<=1_000_000)raw+=chunk;else req.destroy();});
  req.on('end',()=>{
    try {recordDeliveryReport(db,JSON.parse(raw));res.writeHead(204).end();}
    catch {res.writeHead(400).end();}
  });
});
server.listen(port,'0.0.0.0',()=>console.log(`Delivery callback listening on port ${port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
