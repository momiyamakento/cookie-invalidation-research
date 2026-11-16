import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { SiteTokenAuthenticator } from "../apps/management-server/src/internal-auth.js";
import { createEvaluationMetricsRouter } from "../apps/management-server/src/routes/evaluation-metrics.js";
import { evaluationCsv } from "../evaluation/src/csv.js";
import { parseEvaluationOptions } from "../evaluation/src/options.js";
import { runEvaluation } from "../evaluation/src/run-evaluation.js";
import {
  durationStatistics,
  mean,
  median,
  populationStandardDeviation,
  summarize,
} from "../evaluation/src/statistics.js";
import {
  EVALUATION_CSV_COLUMNS,
  type EvaluationRecord,
} from "../evaluation/src/types.js";

function record(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    runId: "run-001",
    trial: 1,
    serviceCount: 3,
    eventId: "event-001",
    finalStatus: "SUCCESS",
    totalDurationMs: 30,
    siteADurationMs: 10,
    siteBDurationMs: 20,
    siteCDurationMs: 30,
    siteARevokedCount: 1,
    siteBRevokedCount: 1,
    siteCRevokedCount: 1,
    cpuUserMicros: 100,
    cpuSystemMicros: 50,
    rssBeforeBytes: 1_000,
    rssAfterBytes: 1_100,
    heapUsedBeforeBytes: 500,
    heapUsedAfterBytes: 550,
    startedAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:00:00.030Z",
    ...overrides,
  };
}

describe("Phase 10 evaluation output", () => {
  it("writes the required CSV columns in a stable order", () => {
    const csv = evaluationCsv([record()]);
    expect(csv.split("\n")[0]).toBe(EVALUATION_CSV_COLUMNS.join(","));
    expect(csv.trimEnd().split("\n")).toHaveLength(2);
  });

  it("does not serialize credentials, cookies, or token hashes", () => {
    const csv = evaluationCsv([record()]);
    for (const secret of [
      "research-password",
      "sid_site_a",
      "decoy_site_a",
      "Bearer",
      "token_hash",
    ]) {
      expect(csv).not.toContain(secret);
    }
  });

  it("parses trial and warm-up counts", () => {
    expect(parseEvaluationOptions(["--trials", "10", "--warmup", "3"])).toEqual({
      trials: 10,
      warmup: 3,
    });
  });

  it("excludes warm-up results and preserves measured trial count", async () => {
    const executor = vi.fn((trial: number, measured: boolean) =>
      Promise.resolve(
        record({ trial, eventId: `${measured ? "measured" : "warmup"}-${trial}` }),
      ),
    );
    const results = await runEvaluation(3, 10, executor);
    expect(executor).toHaveBeenCalledTimes(13);
    expect(results).toHaveLength(10);
    expect(results.every(({ eventId }) => eventId.startsWith("measured-"))).toBe(true);
  });

  it("rejects eventId reuse among measured trials", async () => {
    await expect(
      runEvaluation(0, 2, (trial) =>
        Promise.resolve(record({ trial, eventId: "duplicate" })),
      ),
    ).rejects.toThrow("unique eventId");
  });

  it("aggregates only SUCCESS durations", () => {
    const summary = summarize([
      record({ eventId: "e1", totalDurationMs: 10 }),
      record({ eventId: "e2", totalDurationMs: 30 }),
      record({ eventId: "e3", finalStatus: "FAILED", totalDurationMs: 999 }),
    ]);
    expect(summary).toMatchObject({ trials: 3, successCount: 2 });
    expect(summary.duration).toMatchObject({ count: 2, meanMs: 20, medianMs: 20 });
  });

  it("calculates mean and odd/even median", () => {
    expect(mean([2, 4, 9])).toBe(5);
    expect(median([9, 2, 4])).toBe(4);
    expect(median([8, 2, 4, 6])).toBe(5);
  });

  it("uses population standard deviation", () => {
    expect(populationStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  it("calculates min and max without fixed performance expectations", () => {
    expect(durationStatistics([41, 12, 28])).toMatchObject({
      count: 3,
      minMs: 12,
      maxMs: 41,
    });
  });
});

describe("Phase 10 Management process metrics", () => {
  const authenticator = new SiteTokenAuthenticator({
    "site-a": "site-a-secret",
    "site-b": "site-b-secret",
    "site-c": "site-c-secret",
  });
  const app = express().use(
    "/metrics",
    createEvaluationMetricsRouter(authenticator),
  );

  it("requires an authenticated site token", async () => {
    await request(app).get("/metrics").expect(401, { error: "UNAUTHORIZED" });
  });

  it("returns only process resource counters and sample time", async () => {
    const response = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer site-a-secret")
      .expect(200);
    expect(Object.keys(response.body as object).sort()).toEqual([
      "cpuSystemMicros",
      "cpuUserMicros",
      "heapUsedBytes",
      "rssBytes",
      "sampledAt",
    ]);
    expect(response.body).not.toHaveProperty("token");
  });
});
