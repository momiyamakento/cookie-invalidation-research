import { mkdtemp, readFile, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { parseVerificationOptions, verificationKind, comparisonSource, writeComparison, parseCsv } from "../evaluation/src/zero-delay-verification.js";
import { experimentConditions, runFull } from "../evaluation/src/full-runner.js";
import { replaceResultFile, type ReplaceOperations } from "../evaluation/src/safe-result-write.js";
import { emptyResult, type SessionFactory } from "../evaluation/src/full-types.js";
import { parseFullOptions } from "../evaluation/src/full-options.js";

vi.mock("node:fs/promises", async (original) => {
  const actual=await original<typeof import("node:fs/promises")>();
  return {...actual,rename:vi.fn(actual.rename)};
});

describe("zero-delay verification",()=>{
  it("plans exactly 6 / 30 / 180 / 210 with independent fixed seed and unchanged timeout",()=>{
    const {config}=parseVerificationOptions([]);
    const plan=experimentConditions(config,verificationKind);
    expect([plan.length,plan.length*config.warmup,plan.length*config.trials,plan.length*(config.warmup+config.trials)]).toEqual([6,30,180,210]);
    expect(config).toMatchObject({seed:2026091402,order:"randomized",cooldownMs:2000,timeoutMs:parseFullOptions([]).config.timeoutMs});
    expect(plan.every((c)=>c.experimentType==="Z" && c.loadProfile==="medium" && c.serviceDelayMs===0)).toBe(true);
    expect(plan).toEqual(experimentConditions(parseVerificationOptions([]).config,verificationKind));
    expect(plan.map((c)=>c.serviceCount)).not.toEqual([1,5,10,20,50,100]);
    expect(()=>parseVerificationOptions(["--seed","20260914"])).toThrow();
    expect(()=>parseVerificationOptions(["--resume","x","--smoke"])).toThrow();
  });
  it("retries EPERM then copies without deleting the destination; permanent failure is surfaced",async()=>{
    const error=Object.assign(new Error("locked"),{code:"EPERM"});
    const ops:ReplaceOperations={rename:vi.fn().mockRejectedValue(error),copyFile:vi.fn().mockResolvedValue(undefined),unlink:vi.fn().mockResolvedValue(undefined),pause:vi.fn().mockResolvedValue(undefined)};
    await replaceResultFile("temp","target",ops);
    expect(ops.rename).toHaveBeenCalledTimes(6);expect(ops.copyFile).toHaveBeenCalledWith("temp","target");expect(ops.unlink).toHaveBeenCalledWith("temp");
    vi.mocked(ops.copyFile).mockRejectedValue(error);vi.mocked(ops.unlink).mockClear();
    await expect(replaceResultFile("temp","target",ops)).rejects.toThrow("locked");expect(ops.unlink).not.toHaveBeenCalled();
  });
  it("saves manifest/raw/summary despite EPERM without repeating trials; keeps failures and warmup separate",async()=>{
    const root=await mkdtemp(resolve(tmpdir(),"zero-save-"));
    const original=await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const failures=new Map<string,number>();
    vi.mocked(rename).mockImplementation((from,to)=>{
      const name=String(to);
      if(["manifest.json","raw.csv","summary.csv"].some((s)=>name.endsWith(s)) && (failures.get(name) ?? 0)<6) {
        failures.set(name,(failures.get(name) ?? 0)+1);
        return Promise.reject(Object.assign(new Error("simulated EPERM"),{code:"EPERM"}));
      }
      return original.rename(from,to);
    });
    try {
      const config={...parseVerificationOptions(["--smoke"]).config,serviceCounts:[1]};
      let calls=0;
      const factory:SessionFactory=()=>Promise.resolve({close:()=>Promise.resolve(),trial:()=>{calls++;return Promise.resolve({...emptyResult(calls===2?"TEST":"",calls===2?"failure":""),failureType:calls===2?"TEST":null,allRevoked:calls!==2,invalidationCompletionTimeMs:calls===1?10000:calls,cpuUserMs:calls});}});
      const result=await runFull(config,{experimentKind:verificationKind,resultsRoot:root,factory});
      expect(calls).toBe(3);
      expect(result.manifest.experimentKind).toBe(verificationKind);
      expect(parseCsv(await readFile(resolve(result.directory,"summary.csv"),"utf8"))[0]).toMatchObject({trialCount:"2",successfulTrials:"1",failedTrials:"1",invalidationCompletionTimeMsMean:"2.5"});
      expect(parseCsv(await readFile(resolve(result.directory,"raw.csv"),"utf8"))).toHaveLength(3);
      expect(await readFile(resolve(result.directory,"failures.csv"),"utf8")).toContain("TEST");
      await runFull(config,{experimentKind:verificationKind,resume:result.directory,factory});expect(calls).toBe(3);
      await expect(runFull(config,{resume:result.directory,factory})).rejects.toThrow("different experiment kind");
    } finally {vi.mocked(rename).mockImplementation(original.rename);await rm(root,{recursive:true,force:true});}
  },15000);
  it("creates comparison CSV from read-only A/B summaries and excludes other loads/delays",async()=>{
    const root=await mkdtemp(resolve(tmpdir(),"zero-comparison-"));
    try {
      const config=parseFullOptions(["--experiment","all","--service-counts","1","--load-profiles","medium","--service-delays","0","--warmup","0","--trials","1","--cooldown-ms","0"]).config;
      const factory:SessionFactory=()=>Promise.resolve({close:()=>Promise.resolve(),trial:()=>Promise.resolve({...emptyResult("", ""),failureType:null,allRevoked:true,invalidationCompletionTimeMs:50})});
      const baseline=await runFull(config,{resultsRoot:root,factory});
      const aPath=resolve(baseline.directory,"experiment-a/summary.csv");
      const before=await readFile(aPath,"utf8");
      const a=await comparisonSource(baseline.directory,"A"),b=await comparisonSource(baseline.directory,"B");
      await writeFile(resolve(root,"summary.csv"),before.replaceAll('"A"','"Z"'));
      await writeComparison(root,[a,b]);
      const combined=parseCsv(await readFile(resolve(root,"comparison-source.csv"),"utf8"));
      expect(combined.map((r)=>r.series)).toEqual(["Experiment A","Experiment B","Zero Delay Verification"]);
      expect(await readFile(aPath,"utf8")).toBe(before);
      expect(parseCsv('a,b\n"comma,quote""","line\nbreak"\n')).toEqual([{a:'comma,quote"',b:"line\nbreak"}]);
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
