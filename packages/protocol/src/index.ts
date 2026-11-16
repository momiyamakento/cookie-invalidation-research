export const COMPONENTS = {
  managementServer: {
    id: "management-server",
    name: "Management Server",
    defaultPort: 4100,
  },
  siteA: { id: "site-a", name: "Site A", defaultPort: 3101 },
  siteB: { id: "site-b", name: "Site B", defaultPort: 3102 },
  siteC: { id: "site-c", name: "Site C", defaultPort: 3103 },
  siteD: { id: "site-d", name: "Site D", defaultPort: 3104 },
} as const;

export type Component = (typeof COMPONENTS)[keyof typeof COMPONENTS];

export type SiteServiceId = "site-a" | "site-b" | "site-c" | "site-d";

export type BenchmarkServiceId = `benchmark-${string}`;
export type ManagedServiceId = SiteServiceId | BenchmarkServiceId;

const BENCHMARK_SERVICE_ID = /^benchmark-\d{3,}$/u;

export function isBenchmarkServiceId(value: string): value is BenchmarkServiceId {
  return BENCHMARK_SERVICE_ID.test(value);
}

export function isManagedServiceId(value: string): value is ManagedServiceId {
  return value === "site-a" || value === "site-b" || value === "site-c" ||
    value === "site-d" || isBenchmarkServiceId(value);
}

export interface DetectionNotificationRequest {
  eventId: string;
  serviceId: ManagedServiceId;
  localUserId: string;
  decoyId: string;
  detectedAt: string;
}

export interface DetectionTarget {
  serviceId: ManagedServiceId;
  localUserId: string;
}

export type InvalidationJobStatus = "PENDING" | "SUCCESS" | "FAILED";
export type DetectionProcessingStatus =
  | "RESOLVED"
  | "PROCESSING"
  | "SUCCESS"
  | "PARTIAL_FAILURE"
  | "FAILED";

export interface DetectionInvalidationTarget extends DetectionTarget {
  status: InvalidationJobStatus;
  revokedCount: number | null;
  durationMs: number | null;
  httpStatus: number | null;
}

export interface DetectionNotificationResponse {
  eventId: string;
  principalId: string;
  status:
    | "received"
    | "already_received"
    | DetectionProcessingStatus;
  targets: Array<DetectionTarget | DetectionInvalidationTarget>;
  totalDurationMs?: number | null;
}

export interface SessionRevocationRequest {
  requestId: string;
  eventId: string;
  localUserId: string;
  reason: "DECOY_COOKIE_DETECTED";
  detectedAt: string;
}

export interface SessionRevocationResponse {
  requestId: string;
  eventId: string;
  localUserId: string;
  revokedCount: number;
  status: "success" | "already_processed";
}
