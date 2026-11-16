import type {
  DurationStatistics,
  EvaluationRecord,
  EvaluationSummary,
} from "./types.js";

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? null : (lower + upper) / 2;
}

export function populationStandardDeviation(
  values: readonly number[],
): number | null {
  const average = mean(values);
  if (average === null) return null;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    values.length;
  return Math.sqrt(variance);
}

export function durationStatistics(
  values: readonly number[],
): DurationStatistics {
  return {
    count: values.length,
    meanMs: mean(values),
    medianMs: median(values),
    populationStandardDeviationMs: populationStandardDeviation(values),
    minMs: values.length === 0 ? null : Math.min(...values),
    maxMs: values.length === 0 ? null : Math.max(...values),
  };
}

export function summarize(records: readonly EvaluationRecord[]): EvaluationSummary {
  const successful = records.filter((record) => record.finalStatus === "SUCCESS");
  return {
    runId: records[0]?.runId ?? "",
    trials: records.length,
    successCount: successful.length,
    duration: durationStatistics(
      successful.map((record) => record.totalDurationMs),
    ),
  };
}
