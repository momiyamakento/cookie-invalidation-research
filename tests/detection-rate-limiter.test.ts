import { describe, expect, it } from "vitest";

import { DetectionRateLimiter } from "../apps/management-server/src/detection-rate-limiter.js";

describe("detection rate limiter", () => {
  it("limits only new event IDs per service and releases capacity after the window", () => {
    let now = 1_000_000;
    const limiter = new DetectionRateLimiter(2, 60_000, () => now);

    expect(limiter.check("site-a", "event-1").allowed).toBe(true);
    limiter.record("site-a", "event-1");
    expect(limiter.check("site-a", "event-1").allowed).toBe(true);
    limiter.record("site-a", "event-1");
    expect(limiter.check("site-a", "event-2").allowed).toBe(true);
    limiter.record("site-a", "event-2");
    expect(limiter.check("site-a", "event-3")).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.check("site-b", "event-3").allowed).toBe(true);

    now += 60_000;
    expect(limiter.check("site-a", "event-3").allowed).toBe(true);
  });

  it("rejects invalid limits", () => {
    expect(() => new DetectionRateLimiter(0, 60_000)).toThrow("maxEvents");
    expect(() => new DetectionRateLimiter(1, 0)).toThrow("windowMs");
  });
});
