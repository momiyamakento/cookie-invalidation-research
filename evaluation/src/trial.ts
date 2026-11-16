import type { DetectionInvalidationTarget, SiteServiceId } from "@cookie-research/protocol";

import type { EvaluationRecord } from "./types.js";

interface SiteDefinition {
  baseUrl: string;
  decoyCookieName: string;
  password: string;
  serviceId: SiteServiceId;
  sessionCookieName: string;
  username: string;
}

interface LoginCookies {
  decoy?: string;
  session: string;
}

interface ProcessMetrics {
  cpuUserMicros: number;
  cpuSystemMicros: number;
  rssBytes: number;
  heapUsedBytes: number;
}

interface DetectionResult {
  eventId: string;
  notificationStatus: string;
}

interface InvalidationSnapshot {
  eventId: string;
  status: string;
  totalDurationMs: number;
  targets: DetectionInvalidationTarget[];
}

export interface TrialEnvironment {
  managementBaseUrl: string;
  managementMetricsToken: string;
  runId: string;
  sites: readonly [SiteDefinition, SiteDefinition, SiteDefinition];
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required by the evaluation runner.`);
  }
  return value;
}

function portUrl(environment: NodeJS.ProcessEnv, name: string, fallback: number): string {
  const value = environment[name];
  const port = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return `http://localhost:${port}`;
}

export function loadTrialEnvironment(
  runId: string,
  environment: NodeJS.ProcessEnv = process.env,
): TrialEnvironment {
  const managementBaseUrl = requiredEnvironment(
    environment,
    "MANAGEMENT_BASE_URL",
  ).replace(/\/+$/u, "");
  return {
    runId,
    managementBaseUrl,
    managementMetricsToken: requiredEnvironment(
      environment,
      "SITE_A_TO_MANAGER_TOKEN",
    ),
    sites: [
      {
        baseUrl: portUrl(environment, "SITE_A_PORT", 3101),
        decoyCookieName: "decoy_site_a",
        password: requiredEnvironment(environment, "SITE_A_SEED_PASSWORD"),
        serviceId: "site-a",
        sessionCookieName: "sid_site_a",
        username: "alice-a",
      },
      {
        baseUrl: portUrl(environment, "SITE_B_PORT", 3102),
        decoyCookieName: "decoy_site_b",
        password: requiredEnvironment(environment, "SITE_B_SEED_PASSWORD"),
        serviceId: "site-b",
        sessionCookieName: "sid_site_b",
        username: "alice-b",
      },
      {
        baseUrl: portUrl(environment, "SITE_C_PORT", 3103),
        decoyCookieName: "decoy_site_c",
        password: requiredEnvironment(environment, "SITE_C_SEED_PASSWORD"),
        serviceId: "site-c",
        sessionCookieName: "sid_site_c",
        username: "alice-c",
      },
    ],
  };
}

async function fetchChecked(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} returned HTTP ${response.status}.`);
  }
  return response;
}

function setCookieValues(headers: Headers): string[] {
  const values = headers.getSetCookie();
  if (values.length > 0) return values;
  const combined = headers.get("set-cookie");
  return combined === null ? [] : combined.split(/,(?=\s*[^;,=]+=[^;,]+)/u);
}

function cookieValue(headers: Headers, name: string): string | undefined {
  for (const header of setCookieValues(headers)) {
    const match = new RegExp(`^\\s*${name}=([^;]+)`, "u").exec(header);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

async function login(site: SiteDefinition): Promise<LoginCookies> {
  const response = await fetch(`${site.baseUrl}/login`, {
    method: "POST",
    body: new URLSearchParams({
      username: site.username,
      password: site.password,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 302 && response.status !== 303) {
    throw new Error(`${site.serviceId} login did not redirect.`);
  }
  const session = cookieValue(response.headers, site.sessionCookieName);
  const decoy = cookieValue(response.headers, site.decoyCookieName);
  if (session === undefined || decoy === undefined) {
    throw new Error(`${site.serviceId} login did not issue both cookies.`);
  }
  return { session, decoy };
}

function numberField(body: object, name: string): number {
  const value = Reflect.get(body, name) as unknown;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Response field ${name} is invalid.`);
  }
  return value;
}

function stringField(body: object, name: string): string {
  const value = Reflect.get(body, name) as unknown;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Response field ${name} is invalid.`);
  }
  return value;
}

async function processMetrics(environment: TrialEnvironment): Promise<ProcessMetrics> {
  const response = await fetchChecked(
    `${environment.managementBaseUrl}/api/v1/evaluation/process-metrics`,
    { headers: { Authorization: `Bearer ${environment.managementMetricsToken}` } },
  );
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("Management process metrics response is invalid.");
  }
  return {
    cpuUserMicros: numberField(body, "cpuUserMicros"),
    cpuSystemMicros: numberField(body, "cpuSystemMicros"),
    rssBytes: numberField(body, "rssBytes"),
    heapUsedBytes: numberField(body, "heapUsedBytes"),
  };
}

async function triggerDetection(
  site: SiteDefinition,
  decoy: string,
): Promise<DetectionResult> {
  const response = await fetchChecked(`${site.baseUrl}/__research/decoy-use`, {
    headers: { Cookie: `${site.decoyCookieName}=${decoy}` },
  });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("Site A detector response is invalid.");
  }
  return {
    eventId: stringField(body, "eventId"),
    notificationStatus: stringField(body, "notificationStatus"),
  };
}

function targetField(body: object): DetectionInvalidationTarget[] {
  const value: unknown = Reflect.get(body, "targets");
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("Management snapshot must contain exactly three targets.");
  }
  return value as DetectionInvalidationTarget[];
}

async function invalidationSnapshot(
  environment: TrialEnvironment,
  eventId: string,
): Promise<InvalidationSnapshot> {
  const response = await fetchChecked(
    `${environment.managementBaseUrl}/api/v1/detections/${eventId}/invalidation-jobs`,
  );
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("Management invalidation snapshot is invalid.");
  }
  return {
    eventId: stringField(body, "eventId"),
    status: stringField(body, "status"),
    totalDurationMs: numberField(body, "totalDurationMs"),
    targets: targetField(body),
  };
}

function target(
  snapshot: InvalidationSnapshot,
  serviceId: SiteServiceId,
): DetectionInvalidationTarget {
  const found = snapshot.targets.find((candidate) => candidate.serviceId === serviceId);
  if (found === undefined) throw new Error(`${serviceId} result is missing.`);
  return found;
}

async function verifyRevoked(
  sites: TrialEnvironment["sites"],
  cookies: readonly [LoginCookies, LoginCookies, LoginCookies],
): Promise<void> {
  const statuses = await Promise.all(
    sites.map(async (site, index) => {
      const loginCookie = cookies[index];
      if (loginCookie === undefined) throw new Error("Missing login cookie.");
      const response = await fetch(`${site.baseUrl}/protected`, {
        headers: { Cookie: `${site.sessionCookieName}=${loginCookie.session}` },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      return response.status;
    }),
  );
  if (statuses.some((status) => status !== 401)) {
    throw new Error(`Revocation verification failed: HTTP ${statuses.join(", ")}.`);
  }
}

export async function executeEvaluationTrial(
  environment: TrialEnvironment,
  trial: number,
): Promise<EvaluationRecord> {
  const loginResults = await Promise.all(
    environment.sites.map(async (site) => await login(site)),
  );
  const cookies = loginResults as [LoginCookies, LoginCookies, LoginCookies];
  const siteA = environment.sites[0];
  const siteADecoy = cookies[0].decoy;
  if (siteADecoy === undefined) throw new Error("Site A decoy cookie is missing.");

  const startedAt = new Date().toISOString();
  const before = await processMetrics(environment);
  const detection = await triggerDetection(siteA, siteADecoy);
  if (detection.notificationStatus !== "notified") {
    throw new Error("Site A detection was not delivered to Management Server.");
  }
  const snapshot = await invalidationSnapshot(environment, detection.eventId);
  const after = await processMetrics(environment);
  const completedAt = new Date().toISOString();

  if (snapshot.eventId !== detection.eventId) {
    throw new Error("Management returned a mismatched eventId.");
  }
  const a = target(snapshot, "site-a");
  const b = target(snapshot, "site-b");
  const c = target(snapshot, "site-c");
  if (snapshot.status === "SUCCESS") {
    await verifyRevoked(environment.sites, cookies);
  }

  return {
    runId: environment.runId,
    trial,
    serviceCount: 3,
    eventId: detection.eventId,
    finalStatus: snapshot.status,
    totalDurationMs: snapshot.totalDurationMs,
    siteADurationMs: a.durationMs,
    siteBDurationMs: b.durationMs,
    siteCDurationMs: c.durationMs,
    siteARevokedCount: a.revokedCount,
    siteBRevokedCount: b.revokedCount,
    siteCRevokedCount: c.revokedCount,
    cpuUserMicros: Math.max(0, after.cpuUserMicros - before.cpuUserMicros),
    cpuSystemMicros: Math.max(0, after.cpuSystemMicros - before.cpuSystemMicros),
    rssBeforeBytes: before.rssBytes,
    rssAfterBytes: after.rssBytes,
    heapUsedBeforeBytes: before.heapUsedBytes,
    heapUsedAfterBytes: after.heapUsedBytes,
    startedAt,
    completedAt,
  };
}

export async function verifyServers(environment: TrialEnvironment): Promise<void> {
  await Promise.all([
    fetchChecked(`${environment.managementBaseUrl}/health`),
    ...environment.sites.map(async (site) => await fetchChecked(`${site.baseUrl}/health`)),
  ]);
}
