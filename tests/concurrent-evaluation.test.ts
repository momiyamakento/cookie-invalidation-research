import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import request from "supertest";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";
import { createConcurrentFixture } from "../evaluation/src/concurrent-fixture.js";
import { cookieTiming, type Probe } from "../evaluation/src/concurrent-types.js";

describe("concurrent evaluation", () => {
  it("revokes both sessions for two users, preserves control, and handles a duplicate without changing again", async () => {
    const secret = "concurrent-test-secret";
    const fixture = createConcurrentFixture("benchmark-001", secret);
    try {
      const sessions = fixture.reset(":memory:", [
        { principalId: "p1", localUserId: "account-53" }, { principalId: "p2", localUserId: "account-21" }, { principalId: "control", localUserId: "account-19" },
      ]);
      for (const s of sessions) expect((await request(fixture.app).get("/protected").set("Cookie", s.cookie)).status).toBe(200);
      const bodies = ["account-53", "account-21"].map((localUserId) => ({ eventId: randomUUID(), requestId: randomUUID(), localUserId, reason: "DECOY_COOKIE_DETECTED", detectedAt: new Date().toISOString() }));
      const send = (body: object | undefined, token = deriveBenchmarkToken(secret, "benchmark-001")) => request(fixture.app).post("/internal/v1/sessions/revoke").set("Authorization", `Bearer ${token}`).send(body);
      expect((await send(bodies[0], "incorrect")).status).toBe(401);
      const results = await Promise.all(bodies.map((body) => send(body)));
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(() => fixture.reset(":memory:", [])).toThrow("Finish trial");
      for (const s of sessions) {
        const response = await request(fixture.app).get("/protected").set("Cookie", s.cookie);
        expect(response.status).toBe(s.principalId === "control" ? 200 : 401);
        if (s.principalId === "control") expect(response.body).toMatchObject({ localUserId: s.localUserId });
      }
      expect((await send(bodies[0])).body).toMatchObject({ status: "already_processed", revokedCount: 2 });
      expect((await send({ ...bodies[0], localUserId: "account-19" })).status).toBe(409);
      const snapshot = fixture.finish();
      expect(snapshot.records.reduce((sum, r) => sum + r.changed, 0)).toBe(4);
    } finally { fixture.close(); }
  });

  const probe = (start: number, end: number, status: number): Probe => ({ sessionId: "s", start, end, status, error: null, localUserId: null, due: start });
  it("does not count timeout or 500 as rejection", () => {
    expect(cookieTiming("s", 10, [probe(11, 20, 500), probe(21, 30, 0)]).upper).toBeNull();
  });
  it("uses conservative request bounds and detects reactivation", () => {
    expect(cookieTiming("s", 10, [probe(11, 16, 200), probe(20, 24, 401), probe(30, 33, 200)]))
      .toMatchObject({ lower: 11, upper: 24, reversed: true });
  });
  it("does not invent a completion when one session remains active", () => {
    const observations = [probe(11, 16, 401), { ...probe(11, 16, 200), sessionId: "s2" }];
    expect(["s", "s2"].map((id) => cookieTiming(id, 10, observations)).every((t) => t.upper !== null)).toBe(false);
  });
});
