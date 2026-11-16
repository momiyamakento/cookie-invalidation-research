import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createFullSessionWithOptions } from "./full-session.js";
import { runFull } from "./full-runner.js";
import type { FullConfig, TrialRecord } from "./full-types.js";

type Strategy = "parallel" | "sequential";
type Scenario = "healthy" | "one-target-missing";

interface SummaryRow {
  scenario: Scenario;
  strategy: Strategy;
  serviceCount: number;
  trialCount: number;
  fullSuccessRate: number;
  expectedPartialRate: number | null;
  completionMeanMs: number | null;
  completionMedianMs: number | null;
  completionP95Ms: number | null;
  meanSuccessfulServices: number | null;
  meanFailedServices: number | null;
  resultDirectory: string;
}

function statistic(values: number[]) {
  if (values.length === 0) return { mean: null, median: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { mean, median: sorted[Math.floor((sorted.length - 1) / 2)]!, p95: sorted[Math.ceil(sorted.length * .95) - 1]! };
}

function rows(records: TrialRecord[], scenario: Scenario, strategy: Strategy, resultDirectory: string): SummaryRow[] {
  const measured = records.filter((record) => record.phase === "measurement");
  return [...new Set(measured.map((record) => record.serviceCount))].sort((a, b) => a - b).map((serviceCount) => {
    const sample = measured.filter((record) => record.serviceCount === serviceCount);
    const duration = statistic(sample.flatMap((record) => record.invalidationCompletionTimeMs === null ? [] : [record.invalidationCompletionTimeMs]));
    const fullSuccesses = sample.filter((record) => record.allRevoked).length;
    const expectedPartial = scenario === "one-target-missing"
      ? sample.filter((record) => record.successCount === serviceCount - 1 && record.failureCount === 1).length / sample.length
      : null;
    const average = (values: Array<number | null>) => {
      const present = values.filter((value): value is number => value !== null);
      return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
    };
    return {
      scenario, strategy, serviceCount, trialCount: sample.length,
      fullSuccessRate: sample.length ? fullSuccesses / sample.length : 0,
      expectedPartialRate: expectedPartial,
      completionMeanMs: duration.mean, completionMedianMs: duration.median, completionP95Ms: duration.p95,
      meanSuccessfulServices: average(sample.map((record) => record.successCount)),
      meanFailedServices: average(sample.map((record) => record.failureCount)), resultDirectory,
    };
  });
}

function csv(rowsToWrite: SummaryRow[]) {
  const columns = Object.keys(rowsToWrite[0] ?? {}) as Array<keyof SummaryRow>;
  return `${columns.join(",")}\n${rowsToWrite.map((row) => columns.map((column) => String(row[column] ?? "")).join(",")).join("\n")}\n`;
}

async function main() {
  const smoke = process.argv.slice(2).includes("--smoke");
  if (process.argv.slice(2).some((value) => value !== "--smoke")) throw new Error("Only --smoke is supported.");
  const serviceCounts = smoke ? [1, 5] : [1, 5, 10, 20];
  const warmup = smoke ? 1 : 5;
  const trials = smoke ? 3 : 30;
  const root = resolve("evaluation/results", `cmp-${Date.now()}-${randomUUID().slice(0, 6)}`);
  await mkdir(root, { recursive: true });
  const config: FullConfig = {
    experiment: "delay", serviceCounts, loadProfiles: ["medium"], serviceDelays: [20],
    warmup, trials, order: "randomized", seed: 20260923, cooldownMs: 250, timeoutMs: 15_000,
  };
  const summaries: SummaryRow[] = [];
  for (const scenario of ["healthy", "one-target-missing"] as const) {
    for (const strategy of ["parallel", "sequential"] as const) {
      const result = await runFull(config, {
        resultsRoot: resolve(root, scenario === "healthy" ? "h" : "f", strategy === "parallel" ? "p" : "s"),
        factory: createFullSessionWithOptions({ strategy, ...(scenario === "one-target-missing" ? { notFoundServiceIndex: 1 } : {}) }),
      });
      summaries.push(...rows(result.records, scenario, strategy, result.directory));
    }
  }
  await writeFile(resolve(root, "comparison-summary.csv"), csv(summaries));
  await writeFile(resolve(root, "comparison-summary.json"), `${JSON.stringify({ config, summaries }, null, 2)}\n`);
  console.log(root);
}

void main();
