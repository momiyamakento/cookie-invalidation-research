export const EVALUATION_CSV_COLUMNS = [
  "runId",
  "trial",
  "serviceCount",
  "eventId",
  "finalStatus",
  "totalDurationMs",
  "siteADurationMs",
  "siteBDurationMs",
  "siteCDurationMs",
  "siteARevokedCount",
  "siteBRevokedCount",
  "siteCRevokedCount",
  "cpuUserMicros",
  "cpuSystemMicros",
  "rssBeforeBytes",
  "rssAfterBytes",
  "heapUsedBeforeBytes",
  "heapUsedAfterBytes",
  "startedAt",
  "completedAt",
] as const;

export interface EvaluationRecord {
  runId: string;
  trial: number;
  serviceCount: 3;
  eventId: string;
  finalStatus: string;
  totalDurationMs: number;
  siteADurationMs: number | null;
  siteBDurationMs: number | null;
  siteCDurationMs: number | null;
  siteARevokedCount: number | null;
  siteBRevokedCount: number | null;
  siteCRevokedCount: number | null;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  heapUsedBeforeBytes: number;
  heapUsedAfterBytes: number;
  startedAt: string;
  completedAt: string;
}

export interface DurationStatistics {
  count: number;
  meanMs: number | null;
  medianMs: number | null;
  populationStandardDeviationMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface EvaluationSummary {
  runId: string;
  trials: number;
  successCount: number;
  duration: DurationStatistics;
}
