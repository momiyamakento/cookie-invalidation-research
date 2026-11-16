import { randomUUID, createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, totalmem, release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { secret, port, fetchJson, startManagement, stop } from "./benchmark-scale.js";
import { benchmarkId } from "./benchmark-services.js";
import { accessPlan, summarizeAccess, type Access } from "./coordination-core.js";

class Worker {
  child: ChildProcess;
  private pending = new Map<string, { ok: (v: unknown) => void; bad: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  ready: Promise<unknown>;
  constructor(file: string, args: string[] = []) {
    this.child = fork(resolve(`evaluation/src/${file}`), args, { execArgv: ["--import", "tsx"], env: { ...process.env, CONCURRENT_SECRET: secret }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    this.ready = this.wait("ready");
    this.child.on("message", (raw: unknown) => {
      const m = raw as { id: string; data?: unknown; error?: string }; const p = this.pending.get(m.id);
      if (!p) return; clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.error) p.bad(new Error(m.error)); else p.ok(m.data);
    });
    const fail = (e: Error) => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.bad(e); } this.pending.clear(); };
    this.child.on("error", fail); this.child.on("exit", (code) => fail(new Error(`Worker exited ${code}`)));
  }
  private wait(id: string) { return new Promise<unknown>((ok, bad) => {
    const timer = setTimeout(() => { this.pending.delete(id); bad(new Error(`RPC timeout ${id}`)); }, 30000);
    this.pending.set(id, { ok, bad, timer });
  }); }
  async call<T>(command: string, data: unknown = {}): Promise<T> {
    const id = randomUUID(); const result = this.wait(id); this.child.send({ id, command, data }); return await result as T;
  }
}
interface Session {
  key: string; serviceId: string; localUserId: string; sessionId: string;
  role: "target" | "control"; source: boolean; baseUrl: string; cookie: string;
}
interface State {
  sessions: Array<{ id: string; user_id: string; status: string }>;
  events?: unknown[]; requests?: unknown[]; notices?: unknown[]; records?: unknown[];
}
async function getAccess(s: Session, due: number, origin: number): Promise<Access> {
  const row: Access = { key: s.key, serviceId: s.serviceId, role: s.role, source: s.source,
    due, start: performance.now() - origin, end: null, status: 0, error: null };
  try {
    const r = await fetch(`${s.baseUrl}/protected`, { headers: { Cookie: s.cookie }, signal: AbortSignal.timeout(2000) });
    await r.text(); row.status = r.status;
  } catch (e) { row.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
  row.end = performance.now() - origin; return row;
}
async function check(sessions: Session[]) { return await Promise.all(sessions.map((s) => getAccess(s, 0, performance.now()))); }
async function main() {
  const args = process.argv.slice(2);
  if (args.some((x) => !["--smoke", "--pilot", "--main", "--dry-run"].includes(x))) throw new Error("Unknown option");
  const mode = args.includes("--main") ? "main" : args.includes("--pilot") ? "pilot" : "smoke";
  const config = { version: 1, mode, serviceCount: mode === "smoke" ? 3 : 10, windowMs: mode === "smoke" ? 1000 : 10000,
    intervalMs: 100, concurrencyLimit: 128, requestTimeoutMs: 2000, blocks: mode === "main" ? 3 : 1,
    pairsPerBlock: mode === "main" ? 10 : mode === "pilot" ? 4 : 1, warmupPairsPerBlock: mode === "main" ? 1 : 0,
    order: "alternating within paired repetitions, reversed across blocks", origin: "actual decoy HTTP request send, coordinator monotonic clock",
    population: 2, sessionsPerUserService: 2, primary: "other services only", probePhase: "uniform per-cookie phase within 100ms period",
    baseline: "same detector and source-local revocation; remote notification omitted", naturalExpiry: false };
  if (args.includes("--dry-run")) { console.log(JSON.stringify(config, null, 2)); return; }
  const directory = resolve("evaluation/results", `coordination-${mode}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 6)}`);
  await mkdir(directory, { recursive: true });
  const paths = ["evaluation/src/coordination-cli.ts", "evaluation/src/coordination-core.ts", "evaluation/src/coordination-source-worker.ts",
    "evaluation/COORDINATION-PROTOCOL.md", "evaluation/COORDINATION-MAIN-FROZEN.md", "evaluation/src/coordination-report.py", "tests/coordination-evaluation.test.ts", "evaluation/src/concurrent-fixture.ts", "evaluation/src/concurrent-service-worker.ts", "evaluation/src/benchmark-scale.ts",
    "packages/service-kit/src/research-site/app.ts", "packages/service-kit/src/research-site/runtime.ts",
    "packages/service-kit/src/research-site/repositories/decoy-repository.ts", "packages/service-kit/src/research-site/repositories/session-repository.ts",
    "packages/service-kit/src/research-site/session-revocation-handler.ts", "packages/service-kit/src/detection-notification.ts",
    "apps/management-server/src/services/invalidation-orchestrator.ts", "apps/management-server/src/services/detection-service.ts",
    "apps/management-server/src/site-revocation-client.ts"];
  const hashes: Record<string, string> = {};
  for (const path of paths) { const data = await readFile(path); hashes[path] = createHash("sha256").update(data).digest("hex");
    const dest = resolve(directory, "source-snapshot", `${path}.txt`); await mkdir(resolve(dest, ".."), { recursive: true }); await writeFile(dest, data); }
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify({ config, startedAt: new Date().toISOString(), hashes,
    environment: { node: process.version, os: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memory: totalmem() } }, null, 2));
  console.log(`RESULT_DIRECTORY=${directory}`);
  let trialNumber = 0;
  for (let block = 1; block <= config.blocks; block++) {
    const targets: Array<{ serviceId: string; baseUrl: string; worker: Worker; index: number }> = [];
    try {
      for (let i = 1; i < config.serviceCount; i++) {
        const serviceId = benchmarkId(i); const worker = new Worker("concurrent-service-worker.ts", [serviceId]);
        targets.push({ serviceId, worker, baseUrl: "", index: i });
        const ready = await worker.ready as { port: number }; targets[targets.length - 1]!.baseUrl = `http://127.0.0.1:${ready.port}`;
      }
      const firstRep = config.warmupPairsPerBlock ? 0 : 1;
      for (let repetition = firstRep; repetition <= config.pairsPerBlock; repetition++) {
        const arms = (block + repetition) % 2 ? ["local", "coordinated"] : ["coordinated", "local"];
        for (const arm of arms) {
          const trialId = `b${block}-r${repetition}-${arm}`; const trialDir = resolve(directory, trialId); await mkdir(trialDir);
          await writeFile(resolve(trialDir, "started.json"), JSON.stringify({ trialId, arm, block, repetition, startedAt: new Date().toISOString() }));
          const sessions: Session[] = []; let manager: ChildProcess | undefined; let source: Worker | undefined;
          const access: Access[] = [];
          try {
            for (const service of targets) {
              const rows = await service.worker.call<Array<{ principalId: string; localUserId: string; serviceId: string; sessionId: string; cookie: string }>>("reset", {
                path: resolve(trialDir, `${service.serviceId}.sqlite`), users: ["target", "control"].map((principalId, i) => ({ principalId, localUserId: `account-${service.index}-${i + 7}` })) });
              for (const [n, row] of rows.entries()) sessions.push({ ...row, key: `${service.serviceId}-${row.principalId}-${n % 2}`,
                role: row.principalId as "target" | "control", source: false, baseUrl: service.baseUrl });
            }
            const managerUrl = `http://127.0.0.1:${await port()}`; const managerPath = resolve(trialDir, "manager.sqlite");
            source = new Worker("coordination-source-worker.ts", [resolve(trialDir, "source.sqlite"), managerUrl, arm]);
            const ready = await source.ready as { port: number; password: string }; const sourceUrl = `http://127.0.0.1:${ready.port}`;
            manager = startManagement(managerUrl, managerPath);
            const deadline = Date.now() + 30000;
            for (;;) { try { await fetchJson(`${managerUrl}/health`, undefined, 500); break; }
              catch { if (Date.now() > deadline || manager.exitCode !== null) throw new Error("Manager startup failed"); await delay(50); } }
            // Only this fresh experiment DB is changed; normal application DBs are never opened.
            const db = new Database(managerPath); db.prepare("UPDATE services SET base_url=? WHERE id='site-b'").run(sourceUrl); db.close();
            let decoyCookie = "";
            for (const role of ["target", "control"] as const) for (let k = 0; k < 2; k++) {
              const login = await fetch(`${sourceUrl}/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ username: role, password: ready.password }), signal: AbortSignal.timeout(5000) });
              await login.text(); if (login.status !== 302) throw new Error("Login failed");
              const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]!);
              const cookie = cookies.find((c) => c.startsWith("sid_source=")); if (!cookie) throw new Error("Missing session cookie");
              if (role === "target" && k === 0) decoyCookie = cookies.find((c) => c.startsWith("decoy_source=")) ?? "";
              sessions.push({ key: `site-b-${role}-${k}`, serviceId: "site-b", role, localUserId: `source-${role}`, sessionId: `source-${role}-${k}`, source: true, baseUrl: sourceUrl, cookie });
            }
            if (!decoyCookie) throw new Error("Missing decoy cookie");
            for (const service of targets) for (const [i, principalId] of ["target", "control"].entries()) {
              await fetchJson(`${managerUrl}/api/v1/benchmark-services`, { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ serviceId: service.serviceId, baseUrl: service.baseUrl, principalId, localUserId: `account-${service.index}-${i + 7}` }) });
            }
            for (const principalId of ["target", "control"]) await fetchJson(`${managerUrl}/api/v1/mappings`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ serviceId: "site-b", principalId, localUserId: `source-${principalId}` }) });
            const negatives = [];
            for (const cookie of ["", "decoy_source=not-issued"]) {
              const r = await fetch(`${sourceUrl}/__research/decoy-use`, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(2000) });
              const body: unknown = await r.json(); negatives.push({ status: r.status, body });
            }
            const preSource = await source.call<State>("state"); const preflight = await check(sessions);
            if (negatives[0]?.status !== 400 || negatives[1]?.status !== 404 || preSource.events?.length !== 0 || preSource.requests?.length !== 0 || !preflight.every((r) => r.status === 200)) throw new Error("Negative/preflight failure");
            const selected = sessions.filter((s) => s.role === "target" || s.key.endsWith("-0"));
            const plan = accessPlan(selected, config.windowMs, config.intervalMs);
            const map = new Map(sessions.map((s) => [s.key, s]));
            const planHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
            await delay(100);
            const origin = performance.now();
            const detection = (async () => {
              let status = 0; let body: unknown = null; let error: string | null = null;
              try { const r = await fetch(`${sourceUrl}/__research/decoy-use`, { headers: { Cookie: decoyCookie }, signal: AbortSignal.timeout(15000) }); status = r.status; body = await r.json(); }
              catch (e) { error = String(e); }
              return { start: 0, end: performance.now() - origin, status, body, error };
            })();
            const pending = new Set<Promise<void>>(); let maxPending = 0;
            for (const item of plan) {
              while (performance.now() - origin < item.due) await delay(Math.max(1, item.due - (performance.now() - origin)));
              const s = map.get(item.key)!;
              if (performance.now() - origin >= config.windowMs || pending.size >= config.concurrencyLimit) {
                access.push({ key: s.key, serviceId: s.serviceId, role: s.role, source: s.source, due: item.due, start: null, end: null, status: 0, error: pending.size >= config.concurrencyLimit ? "CONCURRENCY_LIMIT" : "WINDOW_EXPIRED" }); continue;
              }
              const task = getAccess(s, item.due, origin).then((row) => { access.push(row); }).finally(() => { pending.delete(task); });
              pending.add(task); maxPending = Math.max(maxPending, pending.size);
            }
            await Promise.all(pending); await delay(Math.max(0, config.windowMs - (performance.now() - origin)));
            const detected = await detection; const final = await check(sessions); const sourceState = await source.call<State>("state");
            const targetStates = [];
            for (const t of targets) targetStates.push({ serviceId: t.serviceId, ...await t.worker.call<State>("finish") });
            const managerDb = new Database(managerPath, { readonly: true });
            const events = managerDb.prepare("SELECT * FROM detection_events").all(); const jobs = managerDb.prepare("SELECT * FROM invalidation_jobs").all();
            const mappings = managerDb.prepare("SELECT principal_id,service_id,local_user_id FROM user_service_mappings").all(); managerDb.close();
            const primary = summarizeAccess(access, sessions.filter((s) => !s.source && s.role === "target").map((s) => s.key), config.windowMs);
            const sourceSummary = summarizeAccess(access, sessions.filter((s) => s.source && s.role === "target").map((s) => s.key), config.windowMs);
            const finalCorrect = final.every((r) => r.status === (r.role === "target" && (r.source || arm === "coordinated") ? 401 : 200));
            const sourceCorrect = sourceState.sessions.length === 4 && sourceState.sessions.every((r) => r.status === (r.user_id === "source-target" ? "REVOKED" : "ACTIVE"));
            const targetsCorrect = targetStates.every((t) => t.sessions.length === 4 && t.sessions.every((r) => r.status === (arm === "coordinated" && r.user_id.endsWith("-7") ? "REVOKED" : "ACTIVE")));
            const trial = { trialId, arm, block, repetition, phase: repetition === 0 ? "warmup" : "measurement", config, planHash,
              origin, detection: detected, negatives, preflight, access: access.sort((a, b) => a.due - b.due || a.key.localeCompare(b.key)), final,
              primary, sourceSummary, finalCorrect, dbCorrect: sourceCorrect && targetsCorrect, sourceState, targetStates, events, jobs, mappings, maxPending,
              sessions: sessions.map((s) => ({ key: s.key, serviceId: s.serviceId, localUserId: s.localUserId, sessionId: s.sessionId, role: s.role, source: s.source, baseUrl: s.baseUrl })) };
            await writeFile(resolve(trialDir, "trial.json"), JSON.stringify(trial));
            const compact = { trialId, arm, block, repetition, phase: trial.phase, primary, finalCorrect, dbCorrect: trial.dbCorrect, maxPending };
            await appendFile(resolve(directory, "trials.jsonl"), JSON.stringify(compact) + "\n");
            console.log(`${++trialNumber} ${trialId} accepted=${primary.accepted}/${primary.planned} deniedAt=${primary.allDeniedMs?.toFixed(1) ?? "not reached"}ms unknown=${primary.unknown} final=${finalCorrect} db=${trial.dbCorrect}`);
          } catch (e) { await writeFile(resolve(trialDir, "failure.json"), JSON.stringify({ trialId, error: String(e), access })); throw e; }
          finally { if (source) await stop(source.child); if (manager) await stop(manager); }
        }
      }
    } finally { for (const t of targets) await stop(t.worker.child); }
  }
  await writeFile(resolve(directory, "completed.json"), JSON.stringify({ completedAt: new Date().toISOString(), trials: trialNumber }));
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
