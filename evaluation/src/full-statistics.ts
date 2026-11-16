import type { Condition, TrialRecord } from "./full-types.js";
export function statistics(values: readonly (number | null)[]) {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a,b) => a-b);
  const count = v.length;
  if (!count) return { Count: 0, Mean: null, Median: null, Min: null, Max: null, StdDev: null, P95: null };
  const mean = v.reduce((a,b) => a+b,0)/count;
  return { Count: count, Mean: mean, Median: (v[Math.floor((count-1)/2)]!+v[Math.floor(count/2)]!)/2, Min: v[0]!, Max: v[count-1]!, StdDev: Math.sqrt(v.reduce((a,b) => a+(b-mean)**2,0)/count), P95: v[Math.ceil(count*0.95)-1]! };
}
export const systemMetrics = ["invalidationCompletionTimeMs", "cpuUserMs", "cpuSystemMs", "rssBeforeBytes", "rssAfterBytes", "heapUsedBeforeBytes", "heapUsedAfterBytes"] as const;
export const serviceMetrics = ["actualProcessingMs", "measuredDelayMs", "serviceProcessingMs"] as const;
function prefixed(prefix: string, values: readonly (number | null)[]) { return Object.fromEntries(Object.entries(statistics(values)).map(([k,v]) => [prefix+k,v])); }
export function rawRow(record: TrialRecord) {
  const { timings, ...row } = record;
  return { ...row, observedServiceAttempts: timings.length, ...Object.assign({}, ...serviceMetrics.map((key) => prefixed(key, timings.map((t) => t[key])))) } as Record<string, unknown>;
}
export function summarize(condition: Condition, records: TrialRecord[]) {
  const measured = records.filter((r) => r.conditionId === condition.conditionId && r.phase === "measurement");
  const successfulTrials = measured.filter((r) => r.allRevoked && r.failureType === null).length;
  return { ...condition, trialCount: measured.length, successfulTrials, failedTrials: measured.length-successfulTrials, successRate: measured.length ? successfulTrials/measured.length : null,
    ...Object.assign({}, ...systemMetrics.map((key) => prefixed(key, measured.map((r) => r[key])))),
    ...Object.assign({}, ...serviceMetrics.flatMap((key) => ["Mean", "Max"].map((aggregation) => prefixed(key+aggregation, measured.map((r) => statistics(r.timings.map((t) => t[key]))[aggregation as "Mean" | "Max"]))))),
  } as Record<string, unknown>;
}
export function csv(rows: Record<string, unknown>[], fallback: string[] = []) {
  const columns = [...new Set([...fallback, ...rows.flatMap(Object.keys)])];
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  return columns.join(",")+"\n"+rows.map((r) => columns.map((c) => cell(r[c])).join(",")).join("\n")+"\n";
}
