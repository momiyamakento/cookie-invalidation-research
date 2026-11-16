import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDemoApp } from "../apps/demo/src/app.js";
import { loadDemoConfig } from "../apps/demo/src/config.js";
import { validateCondition, type Executor } from "../apps/demo/src/evaluation.js";
const condition = { serviceCount: 1, loadProfile: "medium", serviceDelayMs: 20, warmup: 2, trials: 10 };
async function setup(executor: Executor) {
  const app = createDemoApp(loadDemoConfig({}), executor);
  const page = await request(app).get("/demo/evaluation").expect(200);
  const token = /name="demo-token" content="([a-f0-9]+)"/u.exec(page.text)![1]!;
  return { app, token, page };
}
describe("demo evaluation mode", () => {
  it("renders independent controls, defaults, downloads and links back to the Phase 1 demo", async () => {
    const { app, page } = await setup(() => Promise.reject(new Error("unused")));
    for (const text of ["LIGHT", "MEDIUM", "HEAVY", "0 ms", "20 ms", "100 ms", 'value="2"', 'value="10"', "actualProcessingMs", "measuredDelayMs", "CSVを保存", 'href="/demo"']) expect(page.text).toContain(text);
    const demo = await request(app).get("/demo").expect(200);
    expect(demo.text).toContain('href="/demo/evaluation"');
    expect(demo.text).toContain('id="login-form"');
    expect(demo.text).not.toContain('id="decoy"');
    await request(app).get("/demo/assets/evaluation.js").expect(200);
    await request(app).get("/demo/assets/evaluation.css").expect(200);
  });
  it("accepts only exact typed, bounded conditions", () => {
    expect(validateCondition(condition)).toEqual(condition);
    for (const body of [null, [], {}, { ...condition, command: "whoami" }, { ...condition, trials: "10" },
      { ...condition, serviceCount: 101 }, { ...condition, serviceCount: 2 }, { ...condition, loadProfile: "LIGHT" },
      { ...condition, serviceDelayMs: -1 }, { ...condition, serviceDelayMs: 1000 }, { ...condition, warmup: 21 },
      { ...condition, warmup: 0.5 }, { ...condition, trials: 0 }, { ...condition, trials: 101 }]) expect(validateCondition(body)).toBeUndefined();
  });
  it("rejects invalid API input, unauthorized reads/downloads and cross-site starts", async () => {
    let called = false;
    const { app, token } = await setup(() => { called = true; return Promise.reject(new Error("unused")); });
    await request(app).get("/demo/api/evaluations").expect(403);
    await request(app).get("/demo/api/evaluations/x/files/raw.csv").expect(403);
    await request(app).post("/demo/api/evaluations").set("X-Demo-Token", token).set("Sec-Fetch-Site", "cross-site").send(condition).expect(403);
    await request(app).post("/demo/api/evaluations").set("X-Demo-Token", token).send({ ...condition, path: "C:/secret" }).expect(400);
    await request(app).post("/demo/api/evaluations").set("X-Demo-Token", token).set("Content-Type", "application/json").send('{').expect(400);
    await request(app).get("/demo/api/evaluations/x/files/summary.json").set("X-Demo-Token", token).expect(404);
    expect(called).toBe(false);
  });
  it("rejects all invalid field types and injection strings at the HTTP boundary", async () => {
    let starts = 0;
    const { app, token } = await setup(() => { starts++; return Promise.reject(new Error("must not execute")); });
    const invalid = {
      loadProfile: ["invalid", "", "medium; whoami", "../raw.csv", 1, null],
      serviceCount: [0, -1, 1.5, "1", 101, null],
      serviceDelayMs: [-1, 0.5, "20", 101, {}, null],
      warmup: [-1, 0.5, "2", 21, null],
      trials: [0, -1, 0.5, "10", 101, null],
    };
    for (const [key, values] of Object.entries(invalid)) {
      for (const value of values) {
        await request(app).post("/demo/api/evaluations").set("X-Demo-Token", token)
          .send({ ...condition, [key]: value }).expect(400);
      }
    }
    for (const profile of ["light", "medium", "heavy"]) expect(validateCondition({ ...condition, loadProfile: profile })).toBeDefined();
    expect(starts).toBe(0);
  });
  it("serves exact summary and CSV only for completed allowlisted result files", async () => {
    const base = resolve("evaluation/results");
    const directory = await mkdtemp(resolve(base, "demo-test-"));
    try {
      const summary = { conditions: [{ actualProcessingMs: { meanMs: 0.39 }, measuredDelayMs: { meanMs: 21 }, serviceProcessingMs: { meanMs: 21.39 } }] };
      const csv = "warmup,successCount,failureCount\ntrue,1,0\nfalse,1,0\n";
      await writeFile(resolve(directory, "summary.json"), JSON.stringify(summary));
      await writeFile(resolve(directory, "raw.csv"), csv);
      await writeFile(resolve(directory, "service-timings.csv"), "actualProcessingMs\n0.39\n");
      let complete: (path: string) => void = () => {};
      const { app, token } = await setup(() => new Promise<string>((done) => { complete = done; }));
      const started = await request(app).post("/demo/api/evaluations").set("X-Demo-Token", token).send({ ...condition, trials: 1 }).expect(202);
      const id = (started.body as { id: string }).id;
      await request(app).post("/demo/api/evaluations").set("X-Demo-Token", token).send({ ...condition, trials: 1 }).expect(409);
      complete(directory);
      let job: { status: string; summary?: unknown } | undefined;
      for (let n = 0; n < 30; n++) {
        const response = await request(app).get("/demo/api/evaluations").set("X-Demo-Token", token);
        job = (response.body as Array<{ status: string; summary?: unknown }>)[0];
        if (job?.status !== "running") break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(job).toMatchObject({ status: "completed", summary, successes: 1, failures: 0 });
      expect(job).not.toHaveProperty("directory");
      const file = await request(app).get(`/demo/api/evaluations/${id}/files/raw.csv`).set("X-Demo-Token", token).expect(200);
      expect(file.text).toBe(csv); expect(file.headers["content-disposition"]).toContain("attachment");
      await rm(resolve(directory, "service-timings.csv"));
      await request(app).get(`/demo/api/evaluations/${id}/files/service-timings.csv`).set("X-Demo-Token", token).expect(404);
      await request(app).get(`/demo/api/evaluations/${id}/files/missing.csv`).set("X-Demo-Token", token).expect(404);
      await request(app).get(`/demo/api/evaluations/${id}/files/package.json`).set("X-Demo-Token", token).expect(404);
      await request(app).get(`/demo/api/evaluations/${id}/files/..%2F..%2Fpackage.json`).set("X-Demo-Token", token).expect(404);
    } finally {
      if (!relative(base, directory).startsWith("..")) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  it("does not publish a worker result outside the fixed results directory", async () => {
    const base = resolve("evaluation");
    const directory = await mkdtemp(resolve(base, "demo-outside-"));
    try {
      await writeFile(resolve(directory, "summary.json"), "{}");
      const { app, token } = await setup(() => Promise.resolve(directory));
      const response = await request(app).post("/demo/api/evaluations").set("X-Demo-Token", token).send(condition).expect(202);
      const id = (response.body as { id: string }).id;
      let status: string | undefined;
      for (let n = 0; n < 30; n++) {
        const state = await request(app).get("/demo/api/evaluations").set("X-Demo-Token", token);
        status = (state.body as Array<{ status: string }>)[0]?.status;
        if (status !== "running") break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(status).toBe("failed");
      await request(app).get(`/demo/api/evaluations/${id}/files/summary.json`).set("X-Demo-Token", token).expect(404);
    } finally {
      if (!relative(base, directory).startsWith("..")) await rm(directory, { recursive: true, force: true });
    }
  });
  it("locks synchronously across requests, reports failures and allows another run", async () => {
    let rejectRun: (error: Error) => void = () => {};
    let starts = 0;
    const { app, token } = await setup(() => { starts++; return new Promise((_ok, bad) => { rejectRun = bad; }); });
    const start = () => request(app).post("/demo/api/evaluations").set("X-Demo-Token", token).send(condition);
    const responses = await Promise.all([start(), start()]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]); expect(starts).toBe(1);
    const running = await request(app).get("/demo/api/evaluations").set("X-Demo-Token", token).expect(200);
    expect(running.body).toMatchObject([{ status: "running", condition }]);
    rejectRun(new Error("simulated")); await new Promise((done) => setImmediate(done));
    const failed = await request(app).get("/demo/api/evaluations").set("X-Demo-Token", token);
    expect(failed.body).toMatchObject([{ status: "failed" }]);
    await start().expect(202); expect(starts).toBe(2);
    rejectRun(new Error("simulated"));
  });
});
