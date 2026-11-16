import type { EvaluationRecord } from "./types.js";

export type TrialExecutor = (
  trial: number,
  measured: boolean,
) => Promise<EvaluationRecord>;

export async function runEvaluation(
  warmup: number,
  trials: number,
  executeTrial: TrialExecutor,
): Promise<EvaluationRecord[]> {
  for (let index = 1; index <= warmup; index += 1) {
    await executeTrial(index, false);
  }

  const records: EvaluationRecord[] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    records.push(await executeTrial(trial, true));
  }

  const eventIds = new Set(records.map((record) => record.eventId));
  if (eventIds.size !== records.length) {
    throw new Error("Measured trials did not produce unique eventId values.");
  }
  return records;
}
