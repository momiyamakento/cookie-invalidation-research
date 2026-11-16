import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseVerificationOptions, verificationKind, comparisonSource, writeComparison } from "./zero-delay-verification.js";
import { runFull, readManifest, experimentConditions, atomicJson } from "./full-runner.js";

async function main() {
  const options=parseVerificationOptions(process.argv.slice(2));
  const manifest=options.resume ? await readManifest(options.resume) : undefined;
  if(manifest && manifest.experimentKind!==verificationKind) throw new Error("Only zero-delay verification results can be resumed; A/B results are read-only");
  const config=manifest?.config ?? options.config;
  const conditions=experimentConditions(config,verificationKind);
  const sources=[];
  if(options.compareA) sources.push(await comparisonSource(options.compareA,"A"));
  if(options.compareB) sources.push(await comparisonSource(options.compareB,"B"));
  if(options.dryRun) {
    console.log(JSON.stringify({dryRun:true,experimentKind:verificationKind,conditionCount:conditions.length,warmupCount:conditions.length*config.warmup,measurementCount:conditions.length*config.trials,totalTrials:conditions.length*(config.warmup+config.trials),config,conditions,comparisonSources:sources.map((s)=>s.path)},null,2));
    return;
  }
  let stopping=false;
  const stop=()=>{stopping=true;console.log("Stopping after the current trial is saved...");};
  process.on("SIGINT",stop);process.on("SIGTERM",stop);
  try {
    const result=await runFull(config,{experimentKind:verificationKind,...(options.resume?{resume:options.resume}:{}),stopRequested:()=>stopping});
    await writeComparison(result.directory,sources);
    const graph=spawnSync("python",["evaluation/src/zero-delay-graphs.py",result.directory],{encoding:"utf8"});
    await atomicJson(resolve(result.directory,"chart-status.json"),{success:graph.status===0,error:graph.error?.message ?? graph.stderr ?? null});
    console.log(`${result.manifest.status}: ${result.directory}`);
    if(graph.status!==0) {console.warn("Graph generation failed; all CSV and trial records are preserved.");process.exitCode=1;}
    if(result.manifest.status!=="completed") process.exitCode=130;
  } finally {process.off("SIGINT",stop);process.off("SIGTERM",stop);}
}
main().catch((error:unknown)=>{console.error(error);process.exitCode=1;});
