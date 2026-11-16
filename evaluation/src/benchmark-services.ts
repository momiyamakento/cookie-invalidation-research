import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import express, { type Express } from "express";
import { createSessionRevocationRouter, deriveBenchmarkToken, type SessionRevocationHandler } from "@cookie-research/service-kit";
import type { BenchmarkServiceId } from "@cookie-research/protocol";
import { createBenchmarkLoad, parseLoadProfile, validateServiceDelay, type LoadProfile, type LoadTiming } from "./benchmark-load.js";

export interface ServiceTiming extends LoadTiming {
  serviceDelayMs: number; serviceProcessingMs: number; actualProcessingMs: number; measuredDelayMs: number;
  serviceId: BenchmarkServiceId; loadProfile: LoadProfile; requestId: string; eventId: string;
  receivedAt: string; handlerStartedMs: number; handlerCompletedMs: number;
  processingDurationMs: number; responseFinishedMs: number; httpStatus: number;
}
export interface BenchmarkService {
  app: Express; port: number; serviceId: BenchmarkServiceId; active: boolean;
  loadProfile: LoadProfile; timings: ServiceTiming[]; reset: () => void; close: () => void;
}
export interface BenchmarkCluster { services: BenchmarkService[]; close: () => Promise<void>; }
export interface BenchmarkClusterOptions { notFoundServiceIndex?: number; }

export function benchmarkId(index: number): BenchmarkServiceId {
  return `benchmark-${String(index).padStart(3, "0")}`;
}

export function createBenchmarkService(serviceId: BenchmarkServiceId, port: number, secret: string, profile = process.env.SERVICE_LOAD_PROFILE ?? "light", serviceDelayMs = 0, notFound = false): BenchmarkService {
  validateServiceDelay(serviceDelayMs);
  const loadProfile = parseLoadProfile(profile);
  const load = loadProfile === "light" ? undefined : createBenchmarkLoad(loadProfile);
  let active = true;
  const timings: ServiceTiming[] = [];
  const app = express();
  const context = new AsyncLocalStorage<{ received: number; receivedAt: string; timing?: ServiceTiming }>();
  const handler: SessionRevocationHandler = async (request) => {
    const current = context.getStore();
    if (current === undefined) throw new Error("Missing benchmark timing context.");
    const started = performance.now();
    let revokedCount: number | undefined;
    if (notFound) return { kind: "local_user_not_found" };
    if (load === undefined) {
      if (request.localUserId === "benchmark-user") { revokedCount = active ? 1 : 0; active = false; }
    }
    else revokedCount = load.revoke(request);
    const workCompleted = performance.now();
    const appliedDelayMs = revokedCount === undefined ? 0 : serviceDelayMs;
    if (appliedDelayMs > 0) await delay(appliedDelayMs);
    const completed = appliedDelayMs > 0 ? performance.now() : workCompleted;
    const actualProcessingMs = workCompleted - started;
    const measuredDelayMs = completed - workCompleted;
    const loadTiming: LoadTiming = { actualWorkMs: actualProcessingMs, intentionalDelayMs: appliedDelayMs, observedDelayMs: measuredDelayMs };
    current.timing = { serviceId, loadProfile, requestId: request.requestId, eventId: request.eventId,
      receivedAt: current.receivedAt, handlerStartedMs: started - current.received,
      handlerCompletedMs: completed - current.received, processingDurationMs: completed - started,
      responseFinishedMs: 0, httpStatus: 0, ...loadTiming,
      serviceDelayMs, serviceProcessingMs: actualProcessingMs + measuredDelayMs, actualProcessingMs, measuredDelayMs };
    if (revokedCount === undefined) return { kind: "local_user_not_found" };
    return { kind: "success", record: { ...request, receivedAt: current.receivedAt, revokedCount } };
  };
  app.use("/internal/v1/sessions/revoke", (_req, res, next) => {
    const current: { received: number; receivedAt: string; timing?: ServiceTiming } = {
      received: performance.now(), receivedAt: new Date().toISOString(),
    };
    res.once("finish", () => {
      if (current.timing !== undefined) {
        current.timing.responseFinishedMs = performance.now() - current.received;
        current.timing.httpStatus = res.statusCode;
        timings.push(current.timing);
      }
    });
    context.run(current, next);
  }, createSessionRevocationRouter(deriveBenchmarkToken(secret, serviceId), handler));
  app.get("/health", (_q, r) => r.json({ status: "ok", service: serviceId }));
  app.get("/session", (_q, r) => r.json({ serviceId, state: (load?.active ?? active) ? "ACTIVE" : "REVOKED" }));
  return { app, port, serviceId, loadProfile, timings,
    get active() { return load?.active ?? active; },
    reset: () => { active = true; load?.reset(); timings.length = 0; },
    close: () => load?.close() };
}

export async function startBenchmarkCluster(serviceCount: number, secret: string, basePort = 3200, profile = process.env.SERVICE_LOAD_PROFILE ?? "light", serviceDelayMs = 0, options: BenchmarkClusterOptions = {}): Promise<BenchmarkCluster> {
  validateServiceDelay(serviceDelayMs);
  if (!Number.isInteger(serviceCount) || serviceCount < 1) throw new Error("serviceCount must be at least 1.");
  const loadProfile = parseLoadProfile(profile);
  const services: BenchmarkService[] = [];
  const servers: Array<ReturnType<Express["listen"]>> = [];
  const close = async () => {
    try { await Promise.all(servers.map(async (server) => await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))))); }
    finally { services.forEach((service) => service.close()); }
  };
  try {
    for (let offset = 0; offset < serviceCount; offset += 1) {
      // basePort=0 requests independent OS-assigned ports, avoiding contiguous-port collisions.
      const service = createBenchmarkService(benchmarkId(offset + 1), basePort === 0 ? 0 : basePort + offset + 1, secret, loadProfile, serviceDelayMs, options.notFoundServiceIndex === offset + 1);
      services.push(service);
      const server = await new Promise<ReturnType<Express["listen"]>>((resolve, reject) => {
        const listening = service.app.listen(service.port, "127.0.0.1", () => resolve(listening));
        listening.once("error", reject);
      });
      servers.push(server);
      const address = server.address();
      if (address !== null && typeof address !== "string") service.port = address.port;
    }
  } catch (error) { await close(); throw error; }
  return { services, close };
}
