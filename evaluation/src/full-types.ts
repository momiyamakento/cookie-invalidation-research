import type { LoadProfile } from "./benchmark-load.js";
import type { ServiceTiming } from "./benchmark-services.js";
export interface FullConfig {
  experiment: "processing" | "delay" | "all";
  serviceCounts: number[]; loadProfiles: LoadProfile[]; serviceDelays: number[];
  warmup: number; trials: number; order: "sequential" | "randomized";
  seed: number; cooldownMs: number; timeoutMs: number;
}
export interface Condition {
  experimentType: "A" | "B" | "Z"; conditionId: string; executionOrder: number;
  serviceCount: number; loadProfile: LoadProfile; serviceDelayMs: number;
}
export interface TrialIdentity extends Condition {
  recordId: string; trialNumber: number; phase: "warmup" | "measurement" | "rewarmup";
  segment: number; timestamp: string;
}
export interface TrialResult {
  invalidationCompletionTimeMs: number | null; successCount: number | null; failureCount: number | null;
  allRevoked: boolean; cpuUserMs: number | null; cpuSystemMs: number | null;
  rssBeforeBytes: number | null; rssAfterBytes: number | null;
  heapUsedBeforeBytes: number | null; heapUsedAfterBytes: number | null;
  timings: ServiceTiming[]; failureType: string | null; errorMessage: string | null; fatal: boolean;
}
export type TrialRecord = TrialIdentity & TrialResult;
export interface Manifest {
  experimentKind?: "zero-delay-verification";
  schemaVersion: 1; experimentId: string; config: FullConfig; conditions: Condition[];
  loadModelVersion: string; startedAt: string; endedAt: string | null;
  status: "running" | "interrupted" | "failed" | "completed";
  segment: number; completedConditions: string[]; completedTrials: string[];
  inflight: TrialIdentity | null; failure: string | null;
}
export interface FullSession { trial(): Promise<TrialResult>; close(): Promise<void>; }
export type SessionFactory = (condition: Condition, directory: string, timeoutMs: number) => Promise<FullSession>;
export function emptyResult(failureType: string, errorMessage: string, fatal = false): TrialResult {
  return { invalidationCompletionTimeMs: null, successCount: null, failureCount: null, allRevoked: false,
    cpuUserMs: null, cpuSystemMs: null, rssBeforeBytes: null, rssAfterBytes: null,
    heapUsedBeforeBytes: null, heapUsedAfterBytes: null, timings: [], failureType, errorMessage, fatal };
}
