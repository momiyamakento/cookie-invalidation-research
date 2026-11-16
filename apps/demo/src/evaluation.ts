import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";

export interface EvaluationCondition {
  serviceCount: number; loadProfile: "light" | "medium" | "heavy";
  serviceDelayMs: number; warmup: number; trials: number;
}
export type Executor = (condition: EvaluationCondition) => Promise<string>;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const resultsRoot = resolve(root, "evaluation/results");
const files = ["raw.csv", "service-timings.csv", "summary.json"] as const;

export function validateCondition(body: unknown): EvaluationCondition | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const keys = ["loadProfile", "serviceCount", "serviceDelayMs", "trials", "warmup"];
  if (Object.keys(body).sort().join(",") !== keys.join(",")) return undefined;
  const value = body as EvaluationCondition;
  if (![1, 5, 10, 20, 50, 100].includes(value.serviceCount) ||
    !["light", "medium", "heavy"].includes(value.loadProfile) ||
    ![0, 20, 100].includes(value.serviceDelayMs) ||
    !Number.isInteger(value.warmup) || value.warmup < 0 || value.warmup > 20 ||
    !Number.isInteger(value.trials) || value.trials < 1 || value.trials > 100) return undefined;
  return { serviceCount: value.serviceCount, loadProfile: value.loadProfile,
    serviceDelayMs: value.serviceDelayMs, warmup: value.warmup, trials: value.trials };
}

export const executeBenchmark: Executor = async (c) => await new Promise<string>((ok, bad) => {
  const worker = spawn(process.execPath, ["--import", "tsx", resolve(root, "evaluation/src/demo-worker.ts"),
    "--service-counts", String(c.serviceCount), "--load-profile", c.loadProfile,
    "--service-delay-ms", String(c.serviceDelayMs), "--warmup", String(c.warmup), "--trials", String(c.trials),
  ], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let directory: string | undefined;
  let errorText = "";
  worker.stdout?.resume();
  worker.stderr?.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(-2000); });
  worker.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "directory" in message && typeof message.directory === "string") directory = message.directory;
  });
  worker.once("error", bad);
  worker.once("exit", (code) => {
    if (code === 0 && directory !== undefined) ok(directory);
    else { console.error("Benchmark worker failed:", errorText); bad(new Error("評価に失敗しました。サーバーログとNode/Python環境を確認してください。")); }
  });
});

async function safeFile(directory: string, name: string): Promise<string> {
  const base = await realpath(resultsRoot);
  const target = await realpath(resolve(directory, name));
  const path = relative(base, target);
  if (path.startsWith("..") || isAbsolute(path)) throw new Error("Invalid evaluation result path.");
  return target;
}
interface Job {
  id: string; condition: EvaluationCondition; status: "running" | "completed" | "failed";
  startedAt: string; completedAt?: string; summary?: unknown; successes?: number; failures?: number; error?: string;
  directory?: string;
}

/** One router/store per demo process. A synchronous lock also covers concurrent tabs. */
export function createEvaluationRouter(execute: Executor = executeBenchmark) {
  const router = Router();
  const jobs: Job[] = [];
  const view = (job: Job) => ({ id: job.id, condition: job.condition, status: job.status, startedAt: job.startedAt, completedAt: job.completedAt, summary: job.summary, successes: job.successes, failures: job.failures, error: job.error });
  router.get("/", (_req, res) => res.json(jobs.map(view)));
  router.post("/", (req, res) => {
    const condition = validateCondition(req.body as unknown);
    if (condition === undefined) { res.status(400).json({ error: "条件が不正です。サービス数1/5/10/20/50/100、負荷light/medium/heavy、遅延0/20/100、warm-up 0〜20、測定1〜100の整数を指定してください。" }); return; }
    if (jobs.some((job) => job.status === "running")) { res.status(409).json({ error: "評価実行中です。完了してから開始してください。" }); return; }
    const job: Job = { id: randomUUID(), condition, status: "running", startedAt: new Date().toISOString() };
    jobs.unshift(job);
    if (jobs.length > 30) jobs.pop();
    res.status(202).json(view(job));
    void (async () => {
      try {
        const directory = await execute(condition);
        const summary: unknown = JSON.parse(await readFile(await safeFile(directory, "summary.json"), "utf8"));
        const raw = await readFile(await safeFile(directory, "raw.csv"), "utf8");
        const [header, ...lines] = raw.trim().split(/\r?\n/u);
        const columns = header!.split(",");
        const measured = lines.map((line) => line.split(",")).filter((row) => row[columns.indexOf("warmup")] === "false");
        if (measured.length !== condition.trials) throw new Error("Result trial count mismatch.");
        job.successes = measured.reduce((sum, row) => sum + Number(row[columns.indexOf("successCount")]), 0);
        job.failures = measured.reduce((sum, row) => sum + Number(row[columns.indexOf("failureCount")]), 0);
        job.summary = summary; job.directory = directory; job.status = "completed";
      } catch (error) {
        console.error("Evaluation failed:", error);
        job.status = "failed"; job.error = "評価を完了できませんでした。サーバーログを確認し、条件を減らして再実行してください。";
      } finally { job.completedAt = new Date().toISOString(); }
    })();
  });
  router.get("/:id/files/:name", async (req, res) => {
    const job = jobs.find((item) => item.id === req.params.id);
    const name = req.params.name;
    if (job?.status !== "completed" || job.directory === undefined || !files.some((file) => file === name)) { res.sendStatus(404); return; }
    try { res.download(await safeFile(job.directory, name), name); }
    catch { res.sendStatus(404); }
  });
  return router;
}
