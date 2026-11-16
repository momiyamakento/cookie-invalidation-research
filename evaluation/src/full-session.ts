import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";
import { startBenchmarkCluster, type BenchmarkCluster } from "./benchmark-services.js";
import { secret, port, fetchJson, metrics, startManagement, stop } from "./benchmark-scale.js";
import { emptyResult, type SessionFactory } from "./full-types.js";

export interface FullSessionOptions {
  strategy?: "parallel" | "sequential";
  notFoundServiceIndex?: number;
}

export function createFullSessionWithOptions(options: FullSessionOptions = {}): SessionFactory {
  return async (condition, directory, timeoutMs) => {
  await mkdir(directory, { recursive: true });
  const databasePath = resolve(directory, `management-${randomUUID()}.sqlite`);
  const baseUrl = `http://127.0.0.1:${await port()}`;
  const child = startManagement(baseUrl, databasePath, options.strategy);
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  let cluster: BenchmarkCluster | undefined;
  let database: Database.Database | undefined;
  const close = async () => { try { if (child.pid !== undefined) await stop(child); } finally { try { await cluster?.close(); } finally { database?.close(); } } };
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error("Management exited during preflight");
      try { await fetchJson(`${baseUrl}/health`, undefined, 1000); break; }
      catch { if (Date.now() > deadline) throw new Error("Management preflight timed out"); await new Promise((r) => setTimeout(r, 100)); }
    }
    await metrics(baseUrl);
    cluster = await startBenchmarkCluster(condition.serviceCount, secret, 0, condition.loadProfile, condition.serviceDelayMs, {
      ...(options.notFoundServiceIndex === undefined ? {} : { notFoundServiceIndex: options.notFoundServiceIndex }),
    });
    for (const service of cluster.services) await fetchJson(`${baseUrl}/api/v1/benchmark-services`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId: service.serviceId, baseUrl: `http://127.0.0.1:${service.port}`, principalId: "benchmark-principal", localUserId: "benchmark-user" }),
    });
    database = new Database(databasePath, { fileMustExist: true });
    const services = cluster.services;
    const reset = database.transaction(() => { database!.exec("DELETE FROM invalidation_jobs; DELETE FROM detection_events;"); });
    return { close, trial: async () => {
      const result = emptyResult("ENVIRONMENT", "Trial did not complete", true);
      try {
        reset(); services.forEach((s) => s.reset());
        const before = await metrics(baseUrl);
        result.rssBeforeBytes = before.rssBytes; result.heapUsedBeforeBytes = before.heapUsedBytes;
        const started = performance.now();
        const response = await fetchJson<{ targets: Array<{ status: string }> }>(`${baseUrl}/api/v1/detections`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${deriveBenchmarkToken(secret, "benchmark-001")}` },
          body: JSON.stringify({ eventId: randomUUID(), serviceId: "benchmark-001", localUserId: "benchmark-user", decoyId: randomUUID(), detectedAt: new Date().toISOString() }),
        }, timeoutMs);
        result.invalidationCompletionTimeMs = performance.now() - started;
        const after = await metrics(baseUrl);
        result.cpuUserMs = Math.max(0, (after.cpuUserMicros - before.cpuUserMicros) / 1000);
        result.cpuSystemMs = Math.max(0, (after.cpuSystemMicros - before.cpuSystemMicros) / 1000);
        result.rssAfterBytes = after.rssBytes; result.heapUsedAfterBytes = after.heapUsedBytes;
        result.successCount = response.targets.filter((t) => t.status === "SUCCESS").length;
        result.failureCount = condition.serviceCount - result.successCount;
        result.allRevoked = result.successCount === condition.serviceCount && services.every((s) => !s.active);
        result.fatal = false;
        result.failureType = result.allRevoked ? null : "REVOCATION_FAILED";
        result.errorMessage = result.allRevoked ? null : "Not all expected services were revoked";
        if (services.flatMap((s) => s.timings).length !== condition.serviceCount && !result.failureType) {
          result.failureType = "TIMING_COUNT"; result.errorMessage = "Unexpected service timing count";
        }
      } catch (error) { result.errorMessage = String(error); }
      result.timings = services.flatMap((s) => s.timings.map((t) => ({ ...t })));
      return result;
    } };
  } catch (error) { await close(); throw error; }
  };
}

export const createFullSession: SessionFactory = createFullSessionWithOptions();
