import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseFullOptions, generateConditions } from "./full-options.js";
import { runFull, readManifest, atomicJson } from "./full-runner.js";
async function main() { try {
  const options=parseFullOptions(process.argv.slice(2));
  const config=options.resume ? (await readManifest(options.resume)).config : options.config;
  const conditions=generateConditions(config);
  if (options.dryRun) console.log(JSON.stringify({dryRun:true,config,conditionCount:conditions.length,warmupCount:conditions.length*config.warmup,measurementCount:conditions.length*config.trials,totalTrials:conditions.length*(config.warmup+config.trials),conditions},null,2));
  else {
    let stopping=false;
    const requestStop=() => { stopping=true;console.log("Stopping after the current trial is saved..."); };
    process.on("SIGINT",requestStop);process.on("SIGTERM",requestStop);
    try {
      const result=await runFull(config,{...(options.resume?{resume:options.resume}:{}),stopRequested:()=>stopping});
      const graph=spawnSync("python",["evaluation/src/full-graphs.py",result.directory],{encoding:"utf8"});
      await atomicJson(resolve(result.directory,"chart-status.json"),{success:graph.status===0,error:graph.error?.message ?? graph.stderr ?? null});
      console.log(`${result.manifest.status}: ${result.directory}`);
      if (graph.status!==0) console.warn("Graph generation failed; CSV and checkpoints are preserved.");
      if (result.manifest.status!=="completed") process.exitCode=130;
    } finally { process.off("SIGINT",requestStop);process.off("SIGTERM",requestStop); }
  }
} catch(error) {console.error(error);process.exitCode=1;} }
void main();
