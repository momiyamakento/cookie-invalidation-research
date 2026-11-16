import { isBenchmarkServiceId, type BenchmarkServiceId } from "@cookie-research/protocol";
import { Router, type Request } from "express";

import type { MappingIdentity } from "../db/repositories/mapping-repository.js";
import type { MappingService } from "../services/mapping-service.js";

const MAX_IDENTIFIER_LENGTH = 128;

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_IDENTIFIER_LENGTH
    ? normalized
    : undefined;
}

function requestBody(request: Request):
  | { serviceId: BenchmarkServiceId; baseUrl: string; identity: MappingIdentity }
  | undefined {
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const serviceId = identifier(Reflect.get(body, "serviceId"));
  const baseUrl = identifier(Reflect.get(body, "baseUrl"));
  const principalId = identifier(Reflect.get(body, "principalId"));
  const localUserId = identifier(Reflect.get(body, "localUserId"));
  if (serviceId === undefined || !isBenchmarkServiceId(serviceId) || baseUrl === undefined || principalId === undefined || localUserId === undefined) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch { return undefined; }
  return { serviceId, baseUrl, identity: { principalId, serviceId, localUserId } };
}

/** Evaluation-only dynamic registration for a benchmark service and its mapping. */
export function createBenchmarkServicesRouter(mappingService: MappingService): Router {
  const router = Router();
  router.post("/", (request, response) => {
    const input = requestBody(request);
    if (input === undefined) { response.status(400).json({ error: "INVALID_BENCHMARK_SERVICE_REQUEST" }); return; }
    const result = mappingService.registerBenchmark(input.serviceId, input.baseUrl, input.identity);
    if (result.kind === "conflict") { response.status(409).json({ error: "MAPPING_CONFLICT", ...input.identity }); return; }
    response.status(result.kind === "registered" ? 201 : 200).json({
      ...input.identity, baseUrl: input.baseUrl, status: result.kind,
    });
  });
  return router;
}
