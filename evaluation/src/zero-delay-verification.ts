import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseFullOptions } from "./full-options.js";
import { readManifest, atomicJson } from "./full-runner.js";
import { csv } from "./full-statistics.js";
import { safeWriteResult } from "./safe-result-write.js";

export const verificationKind = "zero-delay-verification" as const;
export const verificationSeed = 2026091402;
export function parseVerificationOptions(argv: readonly string[]) {
  let smoke=false, dryRun=false;
  let resume: string | undefined, compareA: string | undefined, compareB: string | undefined;
  const seen=new Set<string>();
  for (let i=0;i<argv.length;i++) {
    const key=argv[i]!;
    if (seen.has(key)) throw new Error(`Repeated argument: ${key}`);
    seen.add(key);
    if (key==="--smoke") {smoke=true;continue;}
    if (key==="--dry-run") {dryRun=true;continue;}
    if (!["--resume","--compare-a","--compare-b"].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value=argv[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`);
    if (key==="--resume") resume=resolve(value);
    if (key==="--compare-a") compareA=resolve(value);
    if (key==="--compare-b") compareB=resolve(value);
  }
  if (resume && smoke) throw new Error("Resume uses the stored configuration; --smoke cannot be combined");
  const config=parseFullOptions(["--experiment","delay","--load-profiles","medium","--service-delays","0","--order","randomized","--seed",String(verificationSeed)]).config;
  if (smoke) {config.serviceCounts=[1,5];config.warmup=1;config.trials=2;}
  return {config,smoke,dryRun,resume,compareA,compareB};
}

/** RFC4180 quoting, including embedded commas, quotes and newlines. */
export function parseCsv(text: string): Array<Record<string,string>> {
  const rows:string[][]=[];let row:string[]=[];let cell="";let quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i]!;
    if(c==='"') {if(quoted && text[i+1]==='"') {cell+='"';i++;} else quoted=!quoted;}
    else if(c==="," && !quoted) {row.push(cell);cell="";}
    else if(c==="\n" && !quoted) {row.push(cell.replace(/\r$/u,""));if(row.some(Boolean)) rows.push(row);row=[];cell="";}
    else cell+=c;
  }
  if(quoted) throw new Error("Unterminated CSV quote");
  if(cell || row.length) {row.push(cell);rows.push(row);}
  const headers=rows.shift() ?? [];
  return rows.map((values)=>Object.fromEntries(headers.map((key,i)=>[key,values[i] ?? ""])));
}
export async function comparisonSource(directory: string, experiment: "A"|"B") {
  const manifest=await readManifest(directory);
  if(manifest.experimentKind || manifest.config.seed===verificationSeed) throw new Error("Comparison must use A/B with a different seed");
  const path=resolve(directory,`experiment-${experiment.toLowerCase()}`,"summary.csv");
  const text=await readFile(path,"utf8");
  const rows=parseCsv(text).filter((r)=>r.experimentType===experiment && r.loadProfile==="medium" && Number(r.serviceDelayMs)===0);
  if(!rows.length || rows.some((r)=>!r.invalidationCompletionTimeMsMean || !Number.isFinite(Number(r.invalidationCompletionTimeMsMean)) || Number(r.trialCount)<1)) throw new Error(`No measured MEDIUM/0ms rows: ${path}`);
  if(new Set(rows.map((r)=>r.serviceCount)).size!==rows.length) throw new Error(`Duplicate comparison conditions: ${path}`);
  return {path,sha256:createHash("sha256").update(text).digest("hex"),status:manifest.status,seed:manifest.config.seed,rows};
}
export async function writeComparison(directory: string, sources: Awaited<ReturnType<typeof comparisonSource>>[]) {
  const ownPath=resolve(directory,"summary.csv");
  const own=parseCsv(await readFile(ownPath,"utf8"));
  const rows=[...sources.flatMap((s)=>s.rows.map((r)=>({...r,series:`Experiment ${r.experimentType}`,sourceSummary:s.path,sourceSha256:s.sha256}))),
    ...own.map((r)=>({...r,series:"Zero Delay Verification",sourceSummary:ownPath,sourceSha256:""}))];
  await safeWriteResult(resolve(directory,"comparison-source.csv"),csv(rows));
  await atomicJson(resolve(directory,"comparison-inputs.json"),sources.map((source)=>({path:source.path,sha256:source.sha256,status:source.status,seed:source.seed})));
}
