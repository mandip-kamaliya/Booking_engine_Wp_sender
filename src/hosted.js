import { spawn } from 'node:child_process';

const child=(file,args=[]) => spawn(process.execPath,[file,...args],{stdio:'inherit',env:process.env});
const callback=child('src/callback.js');
const watcher=child('src/cli.js',['watch']);
const children=[callback,watcher];
let stopping=false;
const stop=code => {if(stopping)return;stopping=true;for(const process of children) if(!process.killed) process.kill('SIGTERM');process.exitCode=code;};
for(const process of children) process.on('exit',code=>stop(code ?? 1));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>stop(0));
