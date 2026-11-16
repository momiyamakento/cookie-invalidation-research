import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, freemem } from 'node:os';
import Database from 'better-sqlite3';
import { deriveBenchmarkToken } from '@cookie-research/service-kit';
import { startBenchmarkCluster, type BenchmarkCluster } from '../src/benchmark-services.js';
import { secret, metricsToken, port, fetchJson, metrics, stop } from '../src/benchmark-scale.js';
import { parseLoadProfile } from '../src/benchmark-load.js';
import { createProbe } from './probe.mjs';
import type { ProbeSnapshot, ProbeRead } from './probe.mjs';
import type { Metrics } from '../src/benchmark-scale.js';
import type { ServiceTiming } from '../src/benchmark-services.js';

async function main() {
const [directoryArg, countArg, profileArg, modeArg = 'baseline', trialsArg = '30'] = process.argv.slice(2);
if (!directoryArg || !countArg || !profileArg) throw new Error('directory count profile [baseline|force-gc|paced] [trials]');
const count = Number(countArg), profile = parseLoadProfile(profileArg), trials = Number(trialsArg);
if (![50,100].includes(count) || !['baseline','force-gc','paced','paired'].includes(modeArg) || !Number.isInteger(trials) || trials < 1) throw new Error('Invalid diagnostic configuration');
if(modeArg==='paired' && !process.send)throw new Error('Paired mode requires IPC controller');
const directory = resolve(directoryArg);
await mkdir(directory, { recursive: true });
const base = `http://127.0.0.1:${await port()}`, dbPath = resolve(directory, 'management.sqlite');
const child = spawn(process.execPath, ['--expose-gc','--import',pathToFileURL(resolve('evaluation/diagnostics/probe.mjs')).href,'--import','tsx','apps/management-server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, RESEARCH_DIAGNOSTIC_CHILD: '1', MANAGEMENT_SERVER_PORT: new URL(base).port, MANAGEMENT_DB_PATH: dbPath, BENCHMARK_SHARED_SECRET: secret, INVALIDATION_STRATEGY: 'parallel', SITE_A_TO_MANAGER_TOKEN: metricsToken, SITE_B_TO_MANAGER_TOKEN: 'diag-b', SITE_C_TO_MANAGER_TOKEN: 'diag-c', SITE_D_TO_MANAGER_TOKEN: 'diag-d', MANAGER_TO_SITE_A_TOKEN: 'diag-ma', MANAGER_TO_SITE_B_TOKEN: 'diag-mb', MANAGER_TO_SITE_C_TOKEN: 'diag-mc', MANAGER_TO_SITE_D_TOKEN: 'diag-md' }, stdio: ['ignore','ignore','inherit','ipc'], windowsHide: true,
});
let childError: Error | undefined;
child.on('error', e => { childError = e; });
async function diagnostic(command: string): Promise<ProbeRead> {
  if (childError) throw childError;
  return await new Promise((resolveDone,reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Diagnostic IPC timeout')); }, 10000);
    const listener = (message: unknown) => { const m=message as {diagnostic?:boolean;id?:string;error?:string;value:ProbeRead}; if (m?.diagnostic && m.id === id) { clearTimeout(timer); child.off('message',listener); if(m.error) reject(new Error(m.error)); else resolveDone(m.value); } };
    child.on('message', listener); child.send({diagnostic:true,id,command}, e => {if(e){clearTimeout(timer);child.off('message',listener);reject(e);}});
  });
}
const sleep = async (ms: number) => await new Promise(r => setTimeout(r,ms));
const runner = createProbe();
let cluster: BenchmarkCluster | undefined, db: Database.Database | undefined;
const records: Array<{trial:number;warmup:boolean;elapsed:number;absoluteStart:number;absoluteEnd:number;before:Metrics;after:Metrics;managerBefore:ProbeRead;managerAfter:ProbeRead;runnerBefore:ProbeRead;runnerAfter:ProbeRead;hostBefore:ReturnType<typeof host>;hostAfter:ReturnType<typeof host>;timings:ServiceTiming[]}> = [];
function host() { return { freeMemory: freemem(), cpu: cpus().map(c => c.times) }; }
try {
  for (let i=0;;i++) { if(childError) throw childError; if(child.exitCode!==null) throw new Error('Manager exited'); try{ await fetchJson(base+'/health',undefined,1000);break; }catch(e){if(i>200)throw e;await sleep(50);} }
  await metrics(base);
  const setupBefore: {manager:ProbeRead;runner:ProbeSnapshot} = {manager:await diagnostic('read'),runner:runner.snapshot()};
  cluster = await startBenchmarkCluster(count,secret,0,profile,0);
  for (const s of cluster.services) await fetchJson(base+'/api/v1/benchmark-services',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serviceId:s.serviceId,baseUrl:`http://127.0.0.1:${s.port}`,principalId:'benchmark-principal',localUserId:'benchmark-user'})});
  db = new Database(dbPath,{fileMustExist:true});
  const reset = db.transaction(() => db!.exec('DELETE FROM invalidation_jobs; DELETE FROM detection_events;'));
  const setupAfter = {manager:await diagnostic('read'),runner:runner.snapshot()};
  if(modeArg==='paired')process.send?.({ready:true});
  for(let n=1;n<=trials+5;n++) {
    if(modeArg==='paired')await new Promise<void>(resolveGo=>process.once('message',()=>resolveGo()));
    reset();cluster.services.forEach(s=>s.reset());
    if(modeArg==='force-gc') {await diagnostic('gc');global.gc?.();}
    const before = await metrics(base);
    const managerBefore = await diagnostic('reset'), runnerBefore = await runner.read(true), hostBefore = host();
    const start = performance.now(), absoluteStart = performance.timeOrigin+start;
    const response=await fetchJson<{targets:Array<{status:string}>}>(base+'/api/v1/detections',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${deriveBenchmarkToken(secret,'benchmark-001')}`},body:JSON.stringify({eventId:randomUUID(),serviceId:'benchmark-001',localUserId:'benchmark-user',decoyId:randomUUID(),detectedAt:new Date().toISOString()})});
    const elapsed=performance.now()-start, absoluteEnd=performance.timeOrigin+performance.now();
    const after = await metrics(base), managerAfter = await diagnostic('read'), runnerAfter = await runner.read();
    const timings=cluster.services.flatMap(s=>s.timings.map(t=>({...t})));
    if(response.targets.length!==count || response.targets.some(t=>t.status!=='SUCCESS') || cluster.services.some(s=>s.active) || timings.length!==count) throw new Error('Invalid revocation trial');
    records.push({trial:n-5,warmup:n<=5,elapsed,absoluteStart,absoluteEnd,before,after,managerBefore,managerAfter,runnerBefore,runnerAfter,hostBefore,hostAfter:host(),timings});
    if(modeArg==='paired')process.send?.({done:n});
    if(modeArg==='paced')await sleep(Math.max(0,1000-(performance.now()-start)));
  }
  const immediate={manager:await diagnostic('read'),runner:runner.snapshot()};
  await sleep(2500);
  const idle={manager:await diagnostic('read'),runner:runner.snapshot()};
  const collected={manager:await diagnostic('gc'),runner:(global.gc?.(),runner.snapshot())};
  await writeFile(resolve(directory,'diagnostic.json'),JSON.stringify({node:process.version,count,profile,mode:modeArg,trials,warmup:5,scope:'manager child; runner contains all services plus measurement code',setupBefore,setupAfter,immediate,idle,collected,records}));
  console.log(JSON.stringify({directory,count,profile,mode:modeArg,meanMs:records.filter(r=>!r.warmup).reduce((s,r)=>s+r.elapsed,0)/trials}));
} catch(error) {
  await writeFile(resolve(directory,'failure.json'),JSON.stringify({error:String(error),records}));throw error;
} finally {
  runner.close();
  // Only processes created by this script are stopped.
  await stop(child); await cluster?.close(); db?.close();
}
}
void main().catch(error => { console.error(error); process.exitCode=1; });

