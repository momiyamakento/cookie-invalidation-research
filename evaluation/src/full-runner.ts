import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, totalmem, release, version, hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { LOAD_MODEL_VERSION, LOAD_PROFILES } from "./benchmark-load.js";
import { generateConditions, parseFullOptions } from "./full-options.js";
import { csv, rawRow, summarize } from "./full-statistics.js";
import { createFullSession } from "./full-session.js";
import { safeWriteResult } from "./safe-result-write.js";
import { emptyResult, type FullConfig, type Manifest, type TrialRecord, type TrialIdentity, type SessionFactory } from "./full-types.js";

export async function atomicJson(path: string, value: unknown) {
  await safeWriteResult(path, JSON.stringify(value, null, 2)+"\n");
}
export function experimentConditions(config: FullConfig, kind?: "zero-delay-verification") {
  if (!kind) return generateConditions(config);
  if (config.experiment !== "delay" || config.loadProfiles.join() !== "medium" || config.serviceDelays.join() !== "0" || config.order !== "randomized" || config.seed !== 2026091402 || config.cooldownMs !== 2000 || config.timeoutMs !== parseFullOptions([]).config.timeoutMs) throw new Error("Invalid zero-delay verification configuration");
  return generateConditions(config).map((c) => ({...c, experimentType: "Z" as const, conditionId: c.conditionId.replace(/^B-/u,"Z-")}));
}
export async function readManifest(directory: string): Promise<Manifest> {
  const m = JSON.parse(await readFile(resolve(directory,"manifest.json"),"utf8")) as Manifest;
  validateConfig(m.config);
  if (m.schemaVersion !== 1 || m.loadModelVersion !== LOAD_MODEL_VERSION || JSON.stringify(experimentConditions(m.config,m.experimentKind)) !== JSON.stringify(m.conditions)) throw new Error("Incompatible manifest or load model");
  return m;
}
function validateConfig(config: FullConfig) {
  parseFullOptions(["--experiment",config.experiment,"--service-counts",config.serviceCounts.join(","),"--load-profiles",config.loadProfiles.join(","),"--service-delays",config.serviceDelays.join(","),"--warmup",String(config.warmup),"--trials",String(config.trials),"--order",config.order,"--seed",String(config.seed),"--cooldown-ms",String(config.cooldownMs),"--timeout-ms",String(config.timeoutMs)]);
}
function validateIdentity(record: TrialIdentity, manifest: Manifest) {
  const condition=manifest.conditions.find((c) => c.conditionId===record.conditionId);
  const expected=`${record.conditionId}-${record.phase}-${record.phase==="rewarmup"?`${record.segment}-`:""}${record.trialNumber}`;
  if (!condition || Object.entries(condition).some(([k,v]) => record[k as keyof TrialIdentity]!==v) || !["warmup","measurement","rewarmup"].includes(record.phase) || !Number.isInteger(record.trialNumber) || record.trialNumber<1 || record.trialNumber>(record.phase==="measurement"?manifest.config.trials:manifest.config.warmup) || !Number.isInteger(record.segment) || record.segment<1 || record.recordId!==expected) throw new Error("Invalid checkpoint identity");
}
function git(...args: string[]) { try { return execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim(); } catch { return null; } }
async function exportResults(directory: string, manifest: Manifest, records: TrialRecord[]) {
  for (const experimentType of (manifest.experimentKind ? ["Z"] : ["A","B"]) as Array<"A"|"B"|"Z">) {
    const output = experimentType === "Z" ? directory : resolve(directory,`experiment-${experimentType.toLowerCase()}`);
    await mkdir(output,{recursive:true});
    const subset = records.filter((r) => r.experimentType === experimentType);
    const summaries = manifest.conditions.filter((c) => c.experimentType === experimentType).map((c) => summarize(c,subset));
    const files: Record<string,string> = {
      "raw.csv": csv(subset.map(rawRow),["recordId","conditionId","phase","trialNumber"]),
      "summary.csv": csv(summaries,["conditionId","trialCount","successfulTrials","failedTrials","successRate"]),
      "failures.csv": csv(subset.filter((r) => r.failureType !== null).map(rawRow),["recordId","conditionId","phase","failureType","errorMessage"]),
      "service-timings.csv": csv(subset.flatMap((r) => r.timings.map((t) => ({recordId:r.recordId,conditionId:r.conditionId,phase:r.phase,trialNumber:r.trialNumber,...t}))),["recordId","conditionId","phase","trialNumber","serviceId"]),
    };
    for (const [name,content] of Object.entries(files)) await safeWriteResult(resolve(output,name),content);
    await mkdir(resolve(output,"charts"),{recursive:true});
    await safeWriteResult(resolve(output,"charts","source.csv"),files["summary.csv"]!);
    if (experimentType === "Z") await safeWriteResult(resolve(output,"graph-source.csv"),files["summary.csv"]!);
  }
}
export async function runFull(config: FullConfig, options: { resume?: string; resultsRoot?: string; factory?: SessionFactory; stopRequested?: () => boolean; experimentKind?: "zero-delay-verification" } = {}) {
  validateConfig(config);
  experimentConditions(config,options.experimentKind);
  if (options.resume && (await readManifest(options.resume)).experimentKind !== options.experimentKind) throw new Error("Cannot resume a different experiment kind");
  const directory = options.resume ? resolve(options.resume) : resolve(options.resultsRoot ?? "evaluation/results",`${options.experimentKind ?? "full-experiment"}-${new Date().toISOString().replace(/[:.]/gu,"-")}-${randomUUID().slice(0,8)}`);
  await mkdir(directory,{recursive:true});
  const lockPath = resolve(directory,"runner.lock");
  try { const previous = JSON.parse(await readFile(lockPath,"utf8")) as {pid:number;hostname:string};
    if (previous.hostname !== hostname()) throw new Error("Directory is locked on another host");
    let alive = true; try { process.kill(previous.pid,0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive=false; else throw error; }
    if (alive) throw new Error("Directory is already in use"); await unlink(lockPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock = await open(lockPath,"wx"); await lock.writeFile(JSON.stringify({pid:process.pid,hostname:hostname()})); await lock.close();
  let manifest: Manifest | undefined;
  const records: TrialRecord[] = [];
  try {
    await mkdir(resolve(directory,"records"),{recursive:true});
    manifest = options.resume ? await readManifest(directory) : {
      ...(options.experimentKind ? {experimentKind:options.experimentKind} : {}),
      schemaVersion:1,experimentId:directory.split(/[\\/]/u).at(-1)!,config,conditions:experimentConditions(config,options.experimentKind),loadModelVersion:LOAD_MODEL_VERSION,
      startedAt:new Date().toISOString(),endedAt:null,status:"running",segment:0,completedConditions:[],completedTrials:[],inflight:null,failure:null,
    };
    const m = manifest; config=m.config;
    for (const filename of (await readdir(resolve(directory,"records"))).filter((n) => n.endsWith(".json"))) {
      const record = JSON.parse(await readFile(resolve(directory,"records",filename),"utf8")) as TrialRecord;
      validateIdentity(record,m);
      if (!m.conditions.some((c) => c.conditionId === record.conditionId) || filename !== record.recordId+".json" || records.some((r) => r.recordId===record.recordId)) throw new Error("Invalid or duplicate checkpoint");
      records.push(record);
    }
    const save = async () => {
      m.completedTrials=records.map((r) => r.recordId);
      m.completedConditions=m.conditions.filter((c) => records.filter((r) => r.conditionId===c.conditionId && r.phase==="measurement").length===config.trials).map((c) => c.conditionId);
      await atomicJson(resolve(directory,"manifest.json"),m);
    };
    const commit = async (record: TrialRecord) => {
      if (records.some((r) => r.recordId===record.recordId)) throw new Error("Duplicate trial");
      await atomicJson(resolve(directory,"records",record.recordId+".json"),record); records.push(record); m.inflight=null;
      await save(); await exportResults(directory,m,records);
    };
    if (m.inflight) {
      validateIdentity(m.inflight,m);
      if (!records.some((r) => r.recordId===m.inflight!.recordId)) await commit({...m.inflight,...emptyResult("INTERRUPTED","Previous process stopped before committing this trial")});
      m.inflight=null;
    }
    m.segment++; m.status="running";m.failure=null;m.endedAt=null;
    const environment = {timestamp:new Date().toISOString(),os:process.platform,osRelease:release(),osVersion:version(),cpuModel:cpus()[0]?.model ?? null,cpuLogicalCount:cpus().length,totalMemoryBytes:totalmem(),nodeVersion:process.version,gitCommit:git("rev-parse","HEAD"),gitBranch:git("branch","--show-current"),gitStatus:git("status","--porcelain"),config,loadModelVersion:LOAD_MODEL_VERSION,loadProfiles:LOAD_PROFILES,orderAlgorithm:"Mulberry32/Fisher-Yates",benchmarkExecution:"All benchmark services share the runner event loop; synchronous work serializes, asynchronous waits overlap",resourceScope:"Management child process; CPU deltas, memory point samples",statistics:"population stddev; nearest-rank p95; available observations including failed trials; no outlier removal"};
    await atomicJson(resolve(directory,m.segment===1 ? "environment.json" : `environment-resume-${m.segment}.json`),environment);
    await save(); await exportResults(directory,m,records);
    const shouldStop = options.stopRequested ?? (() => false);
    for (const condition of m.conditions) {
      if (m.completedConditions.includes(condition.conditionId)) continue;
      if (shouldStop()) break;
      console.log(`[${condition.executionOrder}/${m.conditions.length}] ${condition.conditionId}`);
      const session = await (options.factory ?? createFullSession)(condition,resolve(directory,"sessions",`${condition.conditionId}-${m.segment}`),config.timeoutMs);
      try {
        await atomicJson(resolve(directory,`preflight-${condition.conditionId}-${m.segment}.json`),{condition,segment:m.segment,timestamp:new Date().toISOString(),success:true,checks:["configuration","results-write","management-start-health-metrics","dynamic-port-binding","benchmark-start-registration"]});
        const resumed = records.some((r) => r.conditionId===condition.conditionId);
        const slots: Array<{phase:TrialIdentity["phase"];trialNumber:number}> = [];
        for (let n=1;n<=config.warmup;n++) slots.push({phase:resumed?"rewarmup":"warmup",trialNumber:n});
        for (let n=1;n<=config.trials;n++) slots.push({phase:"measurement",trialNumber:n});
        for (const slot of slots) {
          const recordId=`${condition.conditionId}-${slot.phase}-${slot.phase==="rewarmup"?`${m.segment}-`:""}${slot.trialNumber}`;
          if (records.some((r) => r.recordId===recordId)) continue;
          if (shouldStop()) break;
          const identity: TrialIdentity={...condition,...slot,recordId,segment:m.segment,timestamp:new Date().toISOString()};
          m.inflight=identity;await save();
          let result; try { result=await session.trial(); } catch (error) { result=emptyResult("ENVIRONMENT",String(error),true); }
          await commit({...identity,...result});
          if (result.fatal) throw new Error(result.errorMessage ?? "Fatal trial error");
        }
      } finally { await session.close(); }
      if (m.completedConditions.length < m.conditions.length && !shouldStop()) {
        const until=Date.now()+config.cooldownMs; while(Date.now()<until && !shouldStop()) await new Promise((r) => setTimeout(r,Math.min(100,until-Date.now())));
      }
    }
    m.status=m.completedConditions.length===m.conditions.length?"completed":"interrupted";m.endedAt=new Date().toISOString();await save();await exportResults(directory,m,records);
    return {directory,manifest:m,records};
  } catch (error) {
    if (manifest) { manifest.status="failed";manifest.failure=String(error);manifest.endedAt=new Date().toISOString();await atomicJson(resolve(directory,"manifest.json"),manifest);await atomicJson(resolve(directory,"runner-failure.json"),{timestamp:new Date().toISOString(),error:String(error)}); }
    throw new Error(`Full evaluation stopped; results: ${directory}`,{cause:error});
  } finally { await unlink(lockPath); }
}
