import { createHmac } from "node:crypto";

import { isBenchmarkServiceId, type BenchmarkServiceId } from "@cookie-research/protocol";

/** Derives a stable, service-scoped bearer token for evaluation-only services. */
export function deriveBenchmarkToken(secret: string, serviceId: BenchmarkServiceId): string {
  if (secret.length < 16) throw new Error("BENCHMARK_SHARED_SECRET must contain at least 16 characters.");
  if (!isBenchmarkServiceId(serviceId)) throw new Error("Invalid benchmark service ID.");
  return createHmac("sha256", secret).update(`cookie-research:${serviceId}`, "utf8").digest("base64url");
}
