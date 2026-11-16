/* global process, console, setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';

const root=resolve(process.argv[2]);
await mkdir(root,{recursive:true});
function event(child,predicate) {return new Promise((ok,bad)=>{
 const timer=setTimeout(()=>finish(new Error('Paired worker timeout')),60000);
 const onMessage=m=>{if(predicate(m))finish(null,m);};
 const onExit=code=>finish(new Error(`Worker exited early ${code}`));
 function finish(error,value){clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);child.off('error',onError);if(error)bad(error);else ok(value);}
 const onError=e=>finish(e);child.on('message',onMessage);child.once('exit',onExit);child.once('error',onError);
});}
for(let block=1;block<=2;block++) {
 const workers=[];
 try {
  for(const profile of ['light','medium']) {
   const dir=resolve(root,`paired-${block}-50-${profile}`);await mkdir(dir,{recursive:true});
   const log=openSync(resolve(dir,'run.log'),'w');
   const child=spawn(process.execPath,['--expose-gc','--import','tsx','evaluation/diagnostics/run-condition.ts',dir,'50',profile,'paired','30'],{stdio:['ignore',log,log,'ipc'],windowsHide:true});closeSync(log);
   workers.push({child,profile,ready:event(child,m=>m.ready),exit:new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',code=>code===0?ok():bad(new Error(`Worker failed ${dir}`)));})});
  }
  await Promise.all(workers.map(w=>w.ready));
  const order=[];
  for(let n=1;n<=35;n++) {
   const sequence=(n+block)%2 ? workers : [...workers].reverse();
   for(const w of sequence) {const done=event(w.child,m=>m.done===n);w.child.send({go:n});await done;order.push({trial:n-5,profile:w.profile});}
  }
  await Promise.all(workers.map(w=>w.exit));
  await writeFile(resolve(root,`paired-order-${block}.json`),JSON.stringify(order));
  console.log(`PAIRED BLOCK ${block} COMPLETE`);
 } finally {for(const w of workers)if(w.child.exitCode===null)w.child.kill();}
}
