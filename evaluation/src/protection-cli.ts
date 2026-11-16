import { randomUUID, createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem, release } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";
import { secret, port, fetchJson, startManagement, stop } from "./benchmark-scale.js";
import { benchmarkId } from "./benchmark-services.js";
import type { FaultMode } from "./protection-fixture.js";

type Strategy = "parallel" | "sequential";
interface Condition { name: string; strategy: Strategy; faultMode: FaultMode; faulty: number[] }
interface State { active: boolean; mode: FaultMode; attempts: number; mutations: number; uniqueRequests: number }
interface Target { serviceId: string; status: string; httpStatus: number | null; revokedCount: number | null }
interface Probe { startMs: number; endMs: number; status: number }
interface ServiceRecord { serviceId: string; faulty: boolean; mode: FaultMode; deniedMs: number | null; bracketLowerMs: number; bracketWidthMs: number | null; finalStatus: number; state: State; target: Target; probes: Probe[] }
interface Trial { block: number; phase: "warmup" | "measurement"; repetition: number; condition: Condition; eventId: string; completionMs: number; healthyProtectedMs: number | null; allProtectedMs: number | null; expected: boolean; services: ServiceRecord[] }
const conditions: Condition[] = [
  { name: "healthy-parallel", strategy: "parallel", faultMode: "healthy", faulty: [] },
  { name: "healthy-sequential", strategy: "sequential", faultMode: "healthy", faulty: [] },
  { name: "before-first-parallel", strategy: "parallel", faultMode: "before", faulty: [1] },
  { name: "before-first-sequential", strategy: "sequential", faultMode: "before", faulty: [1] },
  { name: "before-last-sequential", strategy: "sequential", faultMode: "before", faulty: [10] },
  { name: "before-three-parallel", strategy: "parallel", faultMode: "before", faulty: [1, 5, 10] },
  { name: "after-first-parallel", strategy: "parallel", faultMode: "after", faulty: [1] },
];

function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return { n, mean: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
    median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
    p95: n ? sorted[Math.ceil(n * .95) - 1]! : null, min: sorted[0] ?? null, max: sorted[n - 1] ?? null };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--smoke", "--dry-run"].includes(arg))) throw new Error("Options: --smoke --dry-run");
  const smoke = args.includes("--smoke");
  const config = { serviceCount: 10, blocks: smoke ? 1 : 3, warmupPerConditionPerBlock: 1,
    measuredPerConditionPerBlock: smoke ? 1 : 10, pollIntervalMs: 20, seed: 20261007,
    clientTimeoutMs: 1500, clientMaxAttempts: 3, clientRetryDelayMs: 300, conditions,
    timeOrigin: "immediately before POST /api/v1/detections; decoy detection excluded",
    execution: "one independent child process per service, plus management child; localhost; memory-backed single-session fixtures",
  };
  if (args.includes("--dry-run")) { console.log(JSON.stringify(config, null, 2)); return; }
  const directory = resolve("evaluation/results", `protection-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 6)}`);
  await mkdir(directory, { recursive: true });
  const codePaths = ["evaluation/src/protection-cli.ts", "evaluation/src/protection-fixture.ts", "evaluation/src/protection-worker.ts", "apps/management-server/src/site-revocation-client.ts", "apps/management-server/src/services/invalidation-orchestrator.ts", "packages/service-kit/src/session-revocation.ts"];
  const hashes: Record<string, string> = {};
  for (const path of codePaths) hashes[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify({ config, smoke, startedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() }, hashes }, null, 2));
  console.log(`RESULT_DIRECTORY=${directory}`);
  const trials: Trial[] = [];
  let rng = config.seed;
  const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; };
  const children: ChildProcess[] = [];
  try {
    const services: Array<{ serviceId: string; baseUrl: string }> = [];
    for (let i = 1; i <= config.serviceCount; i += 1) {
      const serviceId = benchmarkId(i);
      const child = fork(resolve("evaluation/src/protection-worker.ts"), [serviceId], { execArgv: ["--import", "tsx"], env: { ...process.env, PROTECTION_FIXTURE_SECRET: secret }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
      children.push(child);
      const servicePort = await new Promise<number>((ok, bad) => {
        const timeout = setTimeout(() => bad(new Error("Fixture startup timeout")), 30000);
        child.once("error", (error) => { clearTimeout(timeout); bad(error); });
        child.once("exit", (code) => { clearTimeout(timeout); bad(new Error(`Fixture exited: ${code}`)); });
        child.once("message", (message: unknown) => {
          clearTimeout(timeout);
          const value: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "port") : undefined;
          if (typeof value !== "number") { bad(new Error("Invalid fixture port")); return; }
          ok(value);
        });
      });
      services.push({ serviceId, baseUrl: `http://127.0.0.1:${servicePort}` });
    }
    for (let block = 1; block <= config.blocks; block += 1) {
      // Separate managers/DBs per strategy and block. Alternate conditions within each repetition.
      const managers = new Map<Strategy, { baseUrl: string; child: ChildProcess; db: Database.Database }>();
      try {
        for (const strategy of ["parallel", "sequential"] as const) {
          const baseUrl = `http://127.0.0.1:${await port()}`;
          const dbPath = resolve(directory, `manager-${block}-${strategy}.sqlite`);
          const child = startManagement(baseUrl, dbPath, strategy);
          children.push(child);
          const deadline = Date.now() + 30000;
          for (;;) {
            try { await fetchJson(`${baseUrl}/health`, undefined, 500); break; }
            catch { if (Date.now() > deadline || child.exitCode !== null) throw new Error("Manager startup failed"); await delay(100); }
          }
          const db = new Database(dbPath);
          managers.set(strategy, { baseUrl, child, db });
          for (const service of services) await fetchJson(`${baseUrl}/api/v1/benchmark-services`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...service, principalId: "protection-principal", localUserId: "protection-user" }),
          });
        }
        for (let repetition = 0; repetition <= config.measuredPerConditionPerBlock; repetition += 1) {
          const order = [...conditions];
          for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
          for (const condition of order) {
            const manager = managers.get(condition.strategy)!;
            manager.db.exec("DELETE FROM invalidation_jobs; DELETE FROM detection_events;");
            const cookies = await Promise.all(services.map(async (service, i) => {
              const result = await fetchJson<{ cookie: string }>(`${service.baseUrl}/control/reset`, {
                method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
                body: JSON.stringify({ mode: condition.faulty.includes(i + 1) ? condition.faultMode : "healthy" }),
              });
              const response = await fetch(`${service.baseUrl}/protected`, { headers: { Cookie: result.cookie }, signal: AbortSignal.timeout(2000) });
              await response.arrayBuffer();
              if (response.status !== 200) throw new Error("Preflight cookie rejected");
              return result.cookie;
            }));
            const eventId = randomUUID();
            const started = performance.now();
            let finished = false;
            const completionPromise = fetchJson<{ targets: Target[] }>(`${manager.baseUrl}/api/v1/detections`, {
              method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${deriveBenchmarkToken(secret, "benchmark-001")}` },
              body: JSON.stringify({ eventId, serviceId: "benchmark-001", localUserId: "protection-user", decoyId: randomUUID(), detectedAt: new Date().toISOString() }),
            }, 30000).then((response) => ({ response, completionMs: performance.now() - started })).finally(() => { finished = true; });
            const probesPromise = Promise.all(services.map(async (service, i) => {
              const probes: Probe[] = [];
              do {
                const startMs = performance.now() - started;
                const response = await fetch(`${service.baseUrl}/protected`, { headers: { Cookie: cookies[i]! }, signal: AbortSignal.timeout(2000) });
                await response.arrayBuffer();
                probes.push({ startMs, endMs: performance.now() - started, status: response.status });
                if (response.status === 401) break;
                if (response.status !== 200) throw new Error(`Unexpected probe status: ${response.status}`);
                if (!finished) await delay(config.pollIntervalMs);
              } while (!finished);
              return probes;
            }));
            const [completionResult, probesResult] = await Promise.allSettled([completionPromise, probesPromise]);
            if (completionResult.status === "rejected") throw completionResult.reason;
            if (probesResult.status === "rejected") throw probesResult.reason;
            const { response, completionMs } = completionResult.value;
            const serviceRecords: ServiceRecord[] = await Promise.all(services.map(async (service, i) => {
              const probes = probesResult.value[i]!;
              // Always a final real-cookie check, also covers a manager response preceding the next poll.
              const startMs = performance.now() - started;
              const check = await fetch(`${service.baseUrl}/protected`, { headers: { Cookie: cookies[i]! }, signal: AbortSignal.timeout(2000) });
              await check.arrayBuffer();
              probes.push({ startMs, endMs: performance.now() - started, status: check.status });
              const firstDenied = probes.find((p) => p.status === 401);
              const earlierSuccesses = probes.filter((p) => p.status === 200 && (!firstDenied || p.startMs < firstDenied.startMs));
              // Request start is a conservative lower bound: service auth happens after it.
              const lower = earlierSuccesses.at(-1)?.startMs ?? 0;
              const state = await fetchJson<State>(`${service.baseUrl}/control/state`, { headers: { Authorization: `Bearer ${secret}` } });
              const target = response.targets.find((t) => t.serviceId === service.serviceId);
              if (!target) throw new Error("Missing manager target");
              return { serviceId: service.serviceId, faulty: condition.faulty.includes(i + 1), mode: state.mode, deniedMs: firstDenied?.endMs ?? null,
                bracketLowerMs: lower, bracketWidthMs: firstDenied ? firstDenied.endMs - lower : null, finalStatus: check.status, state, target, probes };
            }));
            const maximum = (rows: ServiceRecord[]) => rows.every((s) => s.deniedMs !== null) ? Math.max(...rows.map((s) => s.deniedMs!)) : null;
            const expected = serviceRecords.every((s) => {
              const stalled = s.mode !== "healthy";
              const revoked = s.mode !== "before";
              return s.target.status === (stalled ? "FAILED" : "SUCCESS") && s.finalStatus === (revoked ? 401 : 200)
                && s.state.active === !revoked && s.state.attempts === (stalled ? 3 : 1)
                && s.state.mutations === (revoked ? 1 : 0) && s.state.uniqueRequests === (revoked ? 1 : 0);
            });
            const trial: Trial = { block, phase: repetition === 0 ? "warmup" : "measurement", repetition, condition, eventId, completionMs,
              healthyProtectedMs: maximum(serviceRecords.filter((s) => !s.faulty)), allProtectedMs: maximum(serviceRecords), expected, services: serviceRecords };
            trials.push(trial);
            await appendFile(resolve(directory, "trials.jsonl"), `${JSON.stringify(trial)}\n`);
            console.log(`${block}/${config.blocks} ${repetition}/${config.measuredPerConditionPerBlock} ${condition.name} healthy=${trial.healthyProtectedMs?.toFixed(1)}ms completion=${completionMs.toFixed(1)}ms expected=${expected}`);
            if (!expected) throw new Error("State/response/retry validation failed; raw trial preserved");
            await delay(100);
          }
        }
      } finally {
        for (const manager of managers.values()) { await stop(manager.child); manager.db.close(); }
      }
    }
    const measured = trials.filter((t) => t.phase === "measurement");
    const summary = conditions.map((condition) => {
      const rows = measured.filter((t) => t.condition.name === condition.name);
      return { condition, trials: rows.length, expectedTrials: rows.filter((t) => t.expected).length,
        completionMs: statistics(rows.map((t) => t.completionMs)), healthyProtectedMs: statistics(rows.flatMap((t) => t.healthyProtectedMs === null ? [] : [t.healthyProtectedMs])),
        allProtectedMs: statistics(rows.flatMap((t) => t.allProtectedMs === null ? [] : [t.allProtectedMs])),
        probeBracketMs: statistics(rows.flatMap((t) => t.services.flatMap((s) => s.bracketWidthMs === null ? [] : [s.bracketWidthMs]))),
        managerFailures: rows.flatMap((t) => t.services).filter((s) => s.target.status === "FAILED").length,
        failedButRevoked: rows.flatMap((t) => t.services).filter((s) => s.target.status === "FAILED" && s.finalStatus === 401).length,
        stillUsable: rows.flatMap((t) => t.services).filter((s) => s.finalStatus === 200).length,
        blocks: Array.from({ length: config.blocks }, (_, i) => ({ block: i + 1,
          completionMs: statistics(rows.filter((t) => t.block === i + 1).map((t) => t.completionMs)),
          healthyProtectedMs: statistics(rows.filter((t) => t.block === i + 1).flatMap((t) => t.healthyProtectedMs === null ? [] : [t.healthyProtectedMs])) })),
      };
    });
    await writeFile(resolve(directory, "summary.json"), JSON.stringify({ config, finishedAt: new Date().toISOString(), summary }, null, 2));
    await writeFile(resolve(directory, "summary.csv"), "condition,trials,healthy_mean_ms,healthy_median_ms,healthy_p95_ms,completion_mean_ms,completion_p95_ms,manager_failures,failed_but_revoked,still_usable\n" + summary.map((s) => [s.condition.name, s.trials, s.healthyProtectedMs.mean, s.healthyProtectedMs.median, s.healthyProtectedMs.p95, s.completionMs.mean, s.completionMs.p95, s.managerFailures, s.failedButRevoked, s.stillUsable].join(",")).join("\n") + "\n");
    console.log(`COMPLETE ${directory}`);
  } finally { await Promise.all(children.map(stop)); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
