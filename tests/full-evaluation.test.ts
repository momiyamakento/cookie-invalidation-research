import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parseFullOptions, generateConditions } from "../evaluation/src/full-options.js";
import { statistics, summarize, csv } from "../evaluation/src/full-statistics.js";
import { runFull, atomicJson } from "../evaluation/src/full-runner.js";
import { emptyResult, type TrialRecord, type SessionFactory } from "../evaluation/src/full-types.js";

describe("full experiment", () => {
  it("generates separate A/B plans and reproducible randomized order", () => {
    const config=parseFullOptions([]).config;
    const sequential=generateConditions(config);
    expect(sequential).toHaveLength(36);
    expect(sequential.filter((c)=>c.experimentType==="A").every((c)=>c.serviceDelayMs===0)).toBe(true);
    expect(sequential.filter((c)=>c.experimentType==="B").every((c)=>c.loadProfile==="medium")).toBe(true);
    expect(sequential.map((c)=>c.executionOrder)).toEqual(Array.from({length:36},(_,i)=>i+1));
    const random={...config,order:"randomized" as const};
    expect(generateConditions(random)).toEqual(generateConditions(random));
    expect(generateConditions(random)).not.toEqual(sequential);
    expect(generateConditions({...random,seed:1})).not.toEqual(generateConditions(random));
    expect(generateConditions({...config,experiment:"processing"})).toHaveLength(18);
    expect(generateConditions({...config,experiment:"delay"})).toHaveLength(18);
    expect(()=>parseFullOptions(["--resume","x","--trials","2"])).toThrow();
    expect(()=>parseFullOptions(["--trials","0"])).toThrow();
  });
  it("computes population statistics, nearest-rank p95 and preserves outliers", () => {
    expect(statistics(Array.from({length:30},(_,i)=>i+1))).toMatchObject({Count:30,Mean:15.5,Median:15.5,Min:1,Max:30,P95:29});
    expect(statistics([1,3]).StdDev).toBe(1);
    expect(statistics([1,1000000]).Max).toBe(1000000);
    expect(statistics([null]).Count).toBe(0);
    expect(csv([{error:'a,"b"\nc'}])).toContain('"a,""b""\nc"');
  });
  it("excludes warmups from 30-trial summaries including failures", () => {
    const condition=generateConditions(parseFullOptions([]).config)[0]!;
    const records=Array.from({length:31},(_,i):TrialRecord=>({...condition,recordId:String(i),trialNumber:i,segment:1,timestamp:"now",phase:i===0?"warmup":"measurement",...emptyResult("TEST","failure"),invalidationCompletionTimeMs:i===0?99999:i,allRevoked:i!==1,failureType:i===1?"TEST":null}));
    expect(summarize(condition,records)).toMatchObject({trialCount:30,successfulTrials:29,failedTrials:1,invalidationCompletionTimeMsMean:15.5,invalidationCompletionTimeMsP95:29});
  });
  it("persists failures, resumes without duplicates and exports environment/CSVs", async () => {
    const root=await mkdtemp(resolve(tmpdir(),"full-evaluation-"));
    try {
      const config=parseFullOptions(["--experiment","processing","--service-counts","1","--load-profiles","light","--warmup","1","--trials","3","--cooldown-ms","0"]).config;
      let calls=0;
      const factory:SessionFactory=()=>Promise.resolve({close:()=>Promise.resolve(),trial:()=>{calls++;return Promise.resolve({...emptyResult("TEST","saved failure"),invalidationCompletionTimeMs:calls});}});
      const first=await runFull(config,{resultsRoot:root,factory,stopRequested:()=>calls===2});
      expect(first.manifest.status).toBe("interrupted");
      expect(first.records).toHaveLength(2);
      // Simulate a hard interruption after persisting intent, before the result commit.
      first.manifest.inflight={...first.manifest.conditions[0]!,recordId:"A-1-light-0-measurement-2",phase:"measurement",trialNumber:2,segment:1,timestamp:new Date().toISOString()};
      await atomicJson(resolve(first.directory,"manifest.json"),first.manifest);
      const second=await runFull(config,{resume:first.directory,factory});
      expect(second.manifest.status).toBe("completed");
      expect(second.records.filter((r)=>r.phase==="measurement")).toHaveLength(3);
      expect(second.records.filter((r)=>r.phase==="rewarmup")).toHaveLength(1);
      expect(second.records.some((r)=>r.failureType==="INTERRUPTED")).toBe(true);
      expect(new Set(second.records.map((r)=>r.recordId)).size).toBe(second.records.length);
      const prior=calls;
      await runFull(config,{resume:first.directory,factory});expect(calls).toBe(prior);
      for(const file of ["manifest.json","environment.json","experiment-a/raw.csv","experiment-a/summary.csv","experiment-a/failures.csv","experiment-a/charts/source.csv"]) expect((await readFile(resolve(first.directory,file),"utf8")).length).toBeGreaterThan(10);
      expect(await readFile(resolve(first.directory,"experiment-a/failures.csv"),"utf8")).toContain("saved failure");
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("stops fatal trials, retains their checkpoint, and rejects invalid configuration", async () => {
    const root=await mkdtemp(resolve(tmpdir(),"full-fatal-"));
    try {
      const config=parseFullOptions(["--experiment","delay","--service-counts","1","--service-delays","0","--warmup","0","--trials","2","--cooldown-ms","0"]).config;
      let directory="";
      const factory:SessionFactory=(_condition,sessionDirectory)=>{
        directory=resolve(sessionDirectory,"../..");
        return Promise.resolve({close:()=>Promise.resolve(),trial:()=>Promise.resolve(emptyResult("ENVIRONMENT","unreachable",true))});
      };
      await expect(runFull(config,{resultsRoot:root,factory})).rejects.toThrow("Full evaluation stopped");
      const manifest=JSON.parse(await readFile(resolve(directory,"manifest.json"),"utf8")) as {status:string;completedTrials:string[]};
      expect(manifest.status).toBe("failed");expect(manifest.completedTrials).toHaveLength(1);
      expect(await readFile(resolve(directory,"experiment-b/failures.csv"),"utf8")).toContain("unreachable");
      await expect(runFull({...config,trials:0},{resultsRoot:root,factory})).rejects.toThrow();
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
