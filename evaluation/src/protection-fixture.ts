import { randomUUID } from "node:crypto";
import express from "express";
import type { BenchmarkServiceId } from "@cookie-research/protocol";
import { createSessionRevocationRouter, deriveBenchmarkToken, type InvalidationRequestRecord } from "@cookie-research/service-kit";

export type FaultMode = "healthy" | "before" | "after";

/** Local evaluation fixture, not a production authentication implementation. */
export function createProtectionFixture(serviceId: BenchmarkServiceId, secret: string) {
  const app = express();
  let token = randomUUID();
  let active = true;
  let mode: FaultMode = "healthy";
  let attempts = 0;
  let mutations = 0;
  const records = new Map<string, InvalidationRequestRecord>();
  app.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.get("/health", (_req, res) => res.json({ serviceId }));
  app.get("/protected", (req, res) => {
    res.status(active && req.headers.cookie === `sid=${token}` ? 200 : 401).json({ serviceId });
  });
  app.use("/control", (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${secret}`) { res.sendStatus(401); return; }
    next();
  }, express.json());
  app.post("/control/reset", (req, res) => {
    const body: unknown = req.body;
    const value: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "mode") : undefined;
    if (value !== "healthy" && value !== "before" && value !== "after") { res.sendStatus(400); return; }
    mode = value; token = randomUUID(); active = true; attempts = 0; mutations = 0; records.clear();
    res.json({ cookie: `sid=${token}` });
  });
  app.get("/control/state", (_req, res) => res.json({ active, mode, attempts, mutations, uniqueRequests: records.size }));
  app.use("/internal/v1/sessions/revoke", createSessionRevocationRouter(deriveBenchmarkToken(secret, serviceId), (request) => {
    attempts += 1;
    // Accepted, authenticated request with no response and no subsequent state change.
    if (mode === "before") return new Promise<never>(() => {});
    if (request.localUserId !== "protection-user") return { kind: "local_user_not_found" };
    const previous = records.get(request.requestId);
    if (previous && (previous.eventId !== request.eventId || previous.localUserId !== request.localUserId || previous.reason !== request.reason || previous.detectedAt !== request.detectedAt)) return { kind: "request_id_conflict" };
    const record = previous ?? { ...request, receivedAt: new Date().toISOString(), revokedCount: active ? 1 : 0 };
    if (!previous) { active = false; mutations += 1; records.set(request.requestId, record); }
    // Session state is committed, but every acknowledgement is withheld, including retries.
    if (mode === "after") return new Promise<never>(() => {});
    return { kind: previous ? "already_processed" : "success", record };
  }));
  return app;
}
