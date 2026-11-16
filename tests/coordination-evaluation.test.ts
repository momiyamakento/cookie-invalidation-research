import { describe, it, expect } from "vitest";
import { accessPlan, summarizeAccess, type Access } from "../evaluation/src/coordination-core.js";
describe("fixed schedule and censored observations", () => {
  it("uses fixed request counts and phases independent of responses", () => {
    const plan = accessPlan([{ key: "a", role: "target" }, { key: "b", role: "target" }, { key: "c", role: "control" }], 1000, 100);
    expect(plan.filter((p) => p.key === "a").map((p) => p.due)).toEqual([0,100,200,300,400,500,600,700,800,900]);
    expect(plan.filter((p) => p.key === "b")[0]?.due).toBe(50);
    expect(plan.length).toBe(21);
  });
  const row = (key: string, status: number, start: number, end: number): Access => ({ key, serviceId: key, role: "target", source: false, due: start, start, end, status, error: null });
  it("keeps never-rejected cookies censored rather than making the deadline a result", () => {
    const result = summarizeAccess([row("a", 401, 0, 50), row("b",200,0,30)], ["a","b"], 1000);
    expect(result.allDeniedMs).toBeNull(); expect(result.accepted).toBe(1);
  });
  it("does not count response errors or late refusals as protection", () => {
    const result = summarizeAccess([row("a",0,0,10), row("b",401,900,1001)], ["a","b"], 1000);
    expect(result.allDeniedMs).toBeNull(); expect(result.unknown).toBe(1);
  });
  it("detects a new successful request after rejection was observed", () => {
    const result = summarizeAccess([row("a",401,0,10), row("a",200,20,30)], ["a"], 1000);
    expect(result.timings[0]?.acceptedAfter401).toBe(1);
  });
});
