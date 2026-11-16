import { randomUUID, createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, totalmem, release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import Database from "better-sqlite3";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";
import { benchmarkId } from "./benchmark-services.js";
import { secret, port, fetchJson, startManagement, stop, metrics } from "./benchmark-scale.js";
import { cookieTiming, stats, type Session, type Probe, type Notification, type ClockSync } from "./concurrent-types.js";

class Worker {
  child: ChildProcess;
  private pending = new Map<string, { ok: (v: unknown) => void; bad: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  ready: Promise<unknown>;
  constructor(file: string, args: string[] = []) {
    this.child = fork(resolve(`evaluation/src/${file}`), args, { execArgv: ["--import", "tsx"], env: { ...process.env, CONCURRENT_SECRET: secret }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    this.ready = this.wait("ready", 30000);
    this.child.on("message", (raw: unknown) => {
      const m = raw as { id: string; data?: unknown; error?: string };
      const p = this.pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.error) p.bad(new Error(m.error)); else p.ok(m.data);
    });
    const fail = (e: Error) => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.bad(e); } this.pending.clear(); };
    this.child.on("error", fail); this.child.on("exit", (code) => fail(new Error(`Worker exit ${code}`)));
  }
  private wait(id: string, timeout: number) {
    return new Promise<unknown>((ok, bad) => {
      const timer = setTimeout(() => { this.pending.delete(id); bad(new Error(`RPC timeout ${id}`)); }, timeout);
      this.pending.set(id, { ok, bad, timer });
    });
  }
  async call<T>(command: string, data: unknown = {}, timeout = 45000): Promise<T> {
    const id = randomUUID(); const result = this.wait(id, timeout);
    this.child.send({ id, command, data }); return await result as T;
  }
}

async function synchronize(worker: Worker): Promise<ClockSync> {
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now(); const remote = await worker.call<number>("ping"); const end = performance.now();
    samples.push({ start, remote, end, offset: remote - (start + end) / 2, uncertainty: (end - start) / 2 });
  }
  const best = [...samples].sort((a, b) => a.uncertainty - b.uncertainty)[0]!;
  return { samples, offset: best.offset, uncertainty: best.uncertainty };
}
async function pool<T, R>(items: T[], operation: (item: T) => Promise<R>, limit = 32): Promise<R[]> {
  const results: R[] = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; results[i] = await operation(items[i]!); }
  }));
  return results;
}
async function check(sessions: Session[]): Promise<Probe[]> {
  return await pool(sessions, async (s) => {
    const start = performance.now(); let status = 0; let localUserId: string | null = null; let error: string | null = null;
    try {
      const r = await fetch(`${s.baseUrl}/protected`, { headers: { Cookie: s.cookie }, signal: AbortSignal.timeout(2000) });
      const b = await r.json() as { localUserId?: string }; status = r.status; localUserId = b.localUserId ?? null;
    } catch (e) { error = e instanceof Error ? e.name : String(e); }
    return { sessionId: s.sessionId, start, end: performance.now(), status, localUserId, error, due: start };
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some((x) => !["--smoke", "--pilot", "--main", "--paired", "--dry-run", "--interval=50", "--interval=100", "--interval=200"].includes(x))) throw new Error("Unknown option");
  const mode = args.includes("--smoke") ? "smoke" : args.includes("--pilot") ? "pilot" : "main";
  const interval = Number(args.find((x) => x.startsWith("--interval="))?.split("=")[1] ?? 100);
  const config = { version: 2, mode, seed: 20261008, serviceCount: mode === "smoke" ? 2 : 10,
    population: mode === "smoke" ? 3 : 60, candidates: mode === "smoke" ? 2 : 50, sessionsPerUser: 2,
    counts: mode === "smoke" ? [2] : mode === "pilot" ? [1, 10, 50] : [1, 5, 10, 20, 50],
    intervals: mode === "pilot" ? [0, 50, 100, 200] : args.includes("--paired") ? [0, interval] : [interval],
    referenceArm: args.includes("--paired"),
    blocks: mode === "main" ? 3 : 1, repetitions: mode === "main" ? 10 : mode === "pilot" ? 3 : 1,
    warmup: 1, probeLimit: 32, deadlineMs: 30000, strategy: "parallel", retry: { timeoutMs: 1500, maxAttempts: 3, retryDelayMs: 300 },
    clock: "coordinator/load monotonic clock; independent probe worker with 20-sample IPC calibration before/after",
    transport: "Node built-in fetch default dispatcher; probe concurrency 32; no notification retry",
    timing: "notification send to observed cookie rejection; decoy detection excluded; fixed 30s from burst origin",
  };
  if (args.includes("--dry-run")) { console.log(JSON.stringify(config, null, 2)); return; }
  const directory = resolve("evaluation/results", `concurrent-${mode}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 6)}`);
  await mkdir(directory, { recursive: true });
  const paths = ["evaluation/src/concurrent-cli.ts", "evaluation/src/concurrent-fixture.ts", "evaluation/src/concurrent-service-worker.ts", "evaluation/src/concurrent-probe-worker.ts", "evaluation/src/concurrent-types.ts",
    "apps/management-server/src/services/invalidation-orchestrator.ts", "apps/management-server/src/services/detection-service.ts", "apps/management-server/src/site-revocation-client.ts",
    "packages/service-kit/src/research-site/session-revocation-handler.ts", "packages/service-kit/src/research-site/repositories/session-repository.ts",
    "apps/management-server/src/db/schema.ts", "apps/management-server/src/db/repositories/detection-repository.ts",
    "apps/management-server/src/db/repositories/invalidation-job-repository.ts", "apps/management-server/src/db/repositories/mapping-repository.ts",
    "apps/management-server/src/routes/detections.ts", "packages/service-kit/src/session-revocation.ts",
    "packages/service-kit/src/research-site/database.ts", "packages/service-kit/src/research-site/schema.ts", "packages/protocol/src/index.ts",
    "evaluation/src/benchmark-scale.ts", "evaluation/src/concurrent-report.py"];
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    const source = await readFile(path); hashes[path] = createHash("sha256").update(source).digest("hex");
    const destination = resolve(directory, "source-snapshot", `${path}.txt`); await mkdir(resolve(destination, ".."), { recursive: true }); await writeFile(destination, source);
  }
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify({ config, startedAt: new Date().toISOString(), hashes,
    environment: { node: process.version, versions: process.versions, os: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memory: totalmem() } }, null, 2));
  console.log(`RESULT_DIRECTORY=${directory}`);
  let seed = config.seed;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const shuffle = <T>(items: T[]) => { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
  const principalIds = Array.from({ length: config.population }, (_, i) => `${i < config.candidates ? "person" : "control"}-${i + 1}`);
  const conditions = config.counts.flatMap((count) => config.intervals.map((pollMs) => ({ count, pollMs })));
  let trialNumber = 0;
  for (let block = 1; block <= config.blocks; block++) {
    const workers: Worker[] = [];
    try {
      const observer = new Worker("concurrent-probe-worker.ts"); workers.push(observer); await observer.ready;
      const services = [];
      for (let i = 1; i <= config.serviceCount; i++) {
        const serviceId = benchmarkId(i); const worker = new Worker("concurrent-service-worker.ts", [serviceId]); workers.push(worker);
        const { port: servicePort } = await worker.ready as { port: number };
        const permutation = shuffle(Array.from({ length: config.population }, (_, n) => n));
        const users = principalIds.map((principalId, n) => ({ principalId, localUserId: `account-${i}-${permutation[n]! + 101}` }));
        services.push({ worker, serviceId, baseUrl: `http://127.0.0.1:${servicePort}`, users });
      }
      for (let repetition = 0; repetition <= config.repetitions; repetition++) {
        const targetGroups = new Map(config.counts.map((count) => [count, shuffle(principalIds.slice(0, config.candidates)).slice(0, count)]));
        for (const condition of shuffle(conditions)) {
          trialNumber++;
          const trialId = `b${block}-r${repetition}-n${condition.count}-p${condition.pollMs}`;
          const trialDir = resolve(directory, trialId); await mkdir(trialDir);
          const targets = targetGroups.get(condition.count)!;
          const targetSet = new Set(targets);
          const sessions: Session[] = [];
          for (const service of services) {
            const rows = await service.worker.call<Omit<Session, "baseUrl">[]>("reset", { path: resolve(trialDir, `${service.serviceId}.sqlite`), users: service.users });
            sessions.push(...rows.map((s) => ({ ...s, baseUrl: service.baseUrl })));
          }
          const managerUrl = `http://127.0.0.1:${await port()}`;
          const managerPath = resolve(trialDir, "manager.sqlite"); const manager = startManagement(managerUrl, managerPath);
          try {
            const startDeadline = Date.now() + 30000;
            for (;;) {
              try { await fetchJson(`${managerUrl}/health`, undefined, 500); break; }
              catch { if (Date.now() > startDeadline || manager.exitCode !== null) throw new Error("Manager startup failed"); await delay(50); }
            }
            for (const service of services) {
              for (const user of service.users) await fetchJson(`${managerUrl}/api/v1/benchmark-services`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceId: service.serviceId, baseUrl: service.baseUrl, ...user }) });
            }
            for (const principalId of principalIds) {
              const mappings = await fetchJson<{ services: Array<{ serviceId: string; localUserId: string }> }>(`${managerUrl}/api/v1/mappings/${principalId}`);
              if (mappings.services.length !== config.serviceCount || !services.every((s) => mappings.services.some((m) => m.serviceId === s.serviceId && m.localUserId === s.users.find((u) => u.principalId === principalId)!.localUserId))) throw new Error("Mapping preflight failed");
            }
            const preflight = await check(sessions);
            if (!preflight.every((p, i) => p.status === 200 && p.localUserId === sessions[i]!.localUserId)) throw new Error("Cookie preflight failed");
            await observer.call("warm", { urls: services.map((s) => s.baseUrl) });
            const beforeClock = await synchronize(observer);
            const beforeMetrics = await metrics(managerUrl);
            await delay(100);
            const source = services[0]!;
            const requests = targets.map((principalId) => ({ principalId, eventId: randomUUID(), body: {
              eventId: "", serviceId: source.serviceId, localUserId: source.users.find((u) => u.principalId === principalId)!.localUserId,
              decoyId: randomUUID(), detectedAt: new Date().toISOString() } }));
            const payloads = requests.map((r) => ({ ...r, serialized: JSON.stringify({ ...r.body, eventId: r.eventId }) }));
            const origin = performance.now() + 100;
            const observation = condition.pollMs === 0 ? Promise.resolve([] as Probe[]) : observer.call<Probe[]>("observe", {
              sessions: shuffle(sessions), targets, start: origin + beforeClock.offset, deadline: origin + config.deadlineMs + beforeClock.offset, interval: condition.pollMs, limit: config.probeLimit,
            });
            await delay(Math.max(0, origin - performance.now()));
            const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
            const notifications: Notification[] = await Promise.all(payloads.map(async (r) => {
              const start = performance.now(); let status = 0; let body: unknown = null; let error: string | null = null;
              try {
                const response = await fetch(`${managerUrl}/api/v1/detections`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${deriveBenchmarkToken(secret, source.serviceId)}` }, body: r.serialized, signal: AbortSignal.timeout(config.deadlineMs) });
                status = response.status; body = await response.json();
              } catch (e) { error = e instanceof Error ? e.name : String(e); }
              return { principalId: r.principalId, eventId: r.eventId, start, end: performance.now(), status, body, error };
            }));
            const rawProbes = await observation;
            loop.disable();
            const afterMetrics = await metrics(managerUrl);
            const afterClock = await synchronize(observer);
            const probes = rawProbes.map((p) => ({ ...p, start: p.start - beforeClock.offset, end: p.end - beforeClock.offset, due: p.due - beforeClock.offset }));
            const final = await check(sessions);
            const serviceRecords = [];
            for (const s of services) serviceRecords.push({ serviceId: s.serviceId, ...await s.worker.call<{ records: unknown[]; sessions: Array<{ id: string; user_id: string; status: string }> }>("finish") });
            const db = new Database(managerPath, { readonly: true });
            const events = db.prepare("SELECT * FROM detection_events").all(); const jobs = db.prepare("SELECT * FROM invalidation_jobs").all(); db.close();
            const uncertainty = beforeClock.uncertainty + afterClock.uncertainty + Math.abs(beforeClock.offset - afterClock.offset);
            const users = notifications.map((n) => {
              const own = sessions.filter((s) => s.principalId === n.principalId);
              const timings = own.map((s) => cookieTiming(s.sessionId, n.start, probes.filter((p) => p.end <= origin + config.deadlineMs)));
              const complete = condition.pollMs > 0 && timings.every((t) => t.upper !== null);
              return { principalId: n.principalId, eventId: n.eventId, responseMs: n.end - n.start,
                protectedMs: complete ? Math.max(...timings.map((t) => t.upper!)) - n.start : null,
                lowerMs: complete ? Math.max(0, Math.max(...timings.map((t) => t.lower)) - n.start - uncertainty) : null,
                upperMs: complete ? Math.max(...timings.map((t) => t.upper!)) - n.start + uncertainty : null,
                finalDenied: own.every((s) => final.find((p) => p.sessionId === s.sessionId)?.status === 401), timings };
            });
            const finalCorrect = final.every((p, i) => targetSet.has(sessions[i]!.principalId) ? p.status === 401 : p.status === 200 && p.localUserId === sessions[i]!.localUserId);
            const expectedIds = new Set(sessions.filter((s) => targetSet.has(s.principalId)).map((s) => s.sessionId));
            const dbCorrect = serviceRecords.every((s) => s.sessions.every((row) => row.status === (expectedIds.has(row.id) ? "REVOKED" : "ACTIVE")));
            const trial = { trialId, block, repetition, phase: repetition === 0 ? "warmup" : "measurement", condition, targets, origin, deadline: origin + config.deadlineMs,
              notifications, probes, preflight, final, users, beforeClock, afterClock, clockUncertaintyMs: uncertainty,
              beforeMetrics, afterMetrics, loopDelayMaxMs: loop.max / 1e6, sendWidthMs: Math.max(...notifications.map((n) => n.start)) - Math.min(...notifications.map((n) => n.start)),
              finalCorrect, dbCorrect, events, jobs, serviceRecords,
              sessions: sessions.map((s) => ({ sessionId: s.sessionId, principalId: s.principalId, localUserId: s.localUserId, serviceId: s.serviceId, baseUrl: s.baseUrl })) };
            await writeFile(resolve(trialDir, "trial.json"), JSON.stringify(trial));
            await appendFile(resolve(directory, "trials.jsonl"), JSON.stringify({ trialId, block, repetition, phase: trial.phase, condition, finalCorrect, dbCorrect,
              protection: stats(users.flatMap((u) => u.protectedMs === null ? [] : [u.protectedMs])), response: stats(users.map((u) => u.responseMs)), sendWidthMs: trial.sendWidthMs }) + "\n");
            console.log(`${trialNumber} ${trialId} final=${finalCorrect} db=${dbCorrect} protection=${stats(users.flatMap((u) => u.protectedMs === null ? [] : [u.protectedMs])).mean?.toFixed(1)}ms response=${stats(users.map((u) => u.responseMs)).mean?.toFixed(1)}ms`);
          } finally { await stop(manager); }
        }
      }
    } finally { for (const w of workers) await stop(w.child); }
  }
  await writeFile(resolve(directory, "completed.json"), JSON.stringify({ completedAt: new Date().toISOString(), trials: trialNumber }));
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
