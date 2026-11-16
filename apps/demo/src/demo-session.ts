import { randomBytes } from "node:crypto";

export interface DemoEvent { at: string; message: string; key?: string; }
export interface DemoRevocation {
  attempted: boolean;
  eventId: string | null;
  detectedAt: string | null;
  notification: "unknown" | "notified" | "failed";
  principalId: string | null;
  managerStatus: string | null;
  totalDurationMs: number | null;
  targets: Array<{ serviceId: string; localUserId: string; status: string }>;
  error: string | null;
}
export function emptyRevocation(): DemoRevocation {
  return { attempted: false, eventId: null, detectedAt: null, notification: "unknown", principalId: null,
    managerStatus: null, totalDurationMs: null, targets: [], error: null };
}
export interface DemoAttacker {
  status: "idle" | "success" | "denied" | "decoy" | "invalid" | "unavailable" | "revoked";
  successfulCookie: string | null;
  succeededAt: string | null;
  username: string | null;
  sameSession: boolean;
}
export function emptyAttacker(): DemoAttacker {
  return { status: "idle", successfulCookie: null, succeededAt: null, username: null, sameSession: false };
}
export interface DemoSession {
  driveUsername?: string;
  stolenCookies?: Record<string, string>;
  busy: boolean;
  username: string | null;
  cookies: Record<string, Record<string, string>>;
  events: DemoEvent[];
  attacker: DemoAttacker;
  revocation: DemoRevocation;
}

/** Only transient demonstration data; research databases remain owned by the Sites. */
export function createDemoSessionStore() {
  const sessions = new Map<string, DemoSession>();
  return {
    get(id: string | undefined) { return id === undefined ? undefined : sessions.get(id); },
    /** Local-only lookup for reproducing a stolen session in another browser profile. */
    findByCookie(siteId: string, cookieName: string, value: string) {
      for (const session of sessions.values()) {
        if (session.cookies[siteId]?.[cookieName] === value) return session;
      }
      return undefined;
    },
    create() {
      const id = randomBytes(32).toString("hex");
      const session: DemoSession = { busy: false, username: null, cookies: {}, events: [], attacker: emptyAttacker(), revocation: emptyRevocation() };
      sessions.set(id, session);
      return { id, session };
    },
  };
}
