import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import dotenv from "dotenv";

import { writeEvaluationCsv } from "./csv.js";
import { parseEvaluationOptions } from "./options.js";
import { runEvaluation } from "./run-evaluation.js";
import { summarize } from "./statistics.js";
import { executeEvaluationTrial, loadTrialEnvironment, verifyServers } from "./trial.js";

const root = process.cwd();
dotenv.config({ path: resolve(root, ".env"), quiet: true });

function timestamp(date: Date): string {
  const part = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function formatted(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

async function main(): Promise<void> {
  const options = parseEvaluationOptions(process.argv.slice(2));
  const runId = randomUUID();
  const environment = loadTrialEnvironment(runId);
  await verifyServers(environment);

  console.log(`Evaluation ${runId}: ${options.warmup} warm-up + ${options.trials} measured trials`);
  const records = await runEvaluation(
    options.warmup,
    options.trials,
    async (trial, measured) => {
      const label = measured ? `trial ${trial}/${options.trials}` : `warm-up ${trial}/${options.warmup}`;
      const record = await executeEvaluationTrial(environment, trial);
      console.log(`${label}: ${record.finalStatus}, ${record.totalDurationMs} ms`);
      return record;
    },
  );

  const resultsDirectory = resolve(root, "evaluation/results");
  await mkdir(resultsDirectory, { recursive: true });
  const basename = `evaluation-${timestamp(new Date())}`;
  const csvPath = resolve(resultsDirectory, `${basename}.csv`);
  const summaryPath = resolve(resultsDirectory, `${basename}.summary.json`);
  const summary = summarize(records);
  await writeEvaluationCsv(csvPath, records);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  console.log(`Measured trials: ${summary.trials}`);
  console.log(`SUCCESS: ${summary.successCount}`);
  console.log(`Mean: ${formatted(summary.duration.meanMs)} ms`);
  console.log(`Median: ${formatted(summary.duration.medianMs)} ms`);
  console.log(`Population standard deviation: ${formatted(summary.duration.populationStandardDeviationMs)} ms`);
  console.log(`Min / max: ${formatted(summary.duration.minMs)} / ${formatted(summary.duration.maxMs)} ms`);
  console.log(`CSV: ${csvPath}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 1;
});
