export interface Session {
  sessionId: string;
  principalId: string;
  localUserId: string;
  serviceId: string;
  baseUrl: string;
  cookie: string;
}
export interface Probe {
  sessionId: string;
  start: number;
  end: number;
  status: number;
  localUserId: string | null;
  error: string | null;
  due: number;
}
export interface Notification {
  principalId: string;
  eventId: string;
  start: number;
  end: number;
  status: number;
  body: unknown;
  error: string | null;
}
export interface ClockSample { start: number; remote: number; end: number; offset: number; uncertainty: number }
export interface ClockSync { samples: ClockSample[]; offset: number; uncertainty: number }
export interface CookieTiming { sessionId: string; lower: number; upper: number | null; reversed: boolean }
export function cookieTiming(sessionId: string, start: number, probes: Probe[]): CookieTiming {
  const rows = probes.filter((p) => p.sessionId === sessionId && p.end >= start).sort((a, b) => a.start - b.start);
  const denied = rows.find((p) => p.status === 401);
  const successes = rows.filter((p) => p.status === 200 && (!denied || p.start < denied.start));
  return { sessionId, lower: Math.max(start, successes.at(-1)?.start ?? start), upper: denied?.end ?? null,
    reversed: denied !== undefined && rows.some((p) => p.status === 200 && p.start > denied.end) };
}
export function stats(values: number[]) {
  const x = [...values].sort((a, b) => a - b);
  return { n: x.length, mean: x.length ? x.reduce((a, b) => a + b, 0) / x.length : null,
    median: x.length ? (x[Math.floor((x.length - 1) / 2)]! + x[Math.floor(x.length / 2)]!) / 2 : null,
    p95: x.length ? x[Math.ceil(x.length * .95) - 1]! : null, max: x.at(-1) ?? null };
}
