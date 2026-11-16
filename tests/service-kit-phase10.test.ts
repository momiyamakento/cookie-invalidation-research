import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createSessionRevocationRouter,
  type SessionRevocationHandler,
} from "@cookie-research/service-kit";

const REQUEST = {
  requestId: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  localUserId: "external-user-001",
  reason: "DECOY_COOKIE_DETECTED" as const,
  detectedAt: "2026-08-31T00:00:00.000Z",
};

function app(handler: SessionRevocationHandler) {
  const application = express();
  application.use(
    "/internal/v1/sessions/revoke",
    createSessionRevocationRouter("manager-to-service-token", handler),
  );
  return application;
}

describe("Phase 10 service-kit revocation router", () => {
  it("passes an authenticated request to the Site-owned revocation handler", async () => {
    const handler = vi.fn<SessionRevocationHandler>(() => ({
      kind: "success",
      record: { ...REQUEST, receivedAt: "2026-08-31T00:00:01.000Z", revokedCount: 2 },
    }));

    const response = await request(app(handler))
      .post("/internal/v1/sessions/revoke")
      .set("Authorization", "Bearer manager-to-service-token")
      .send(REQUEST);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      requestId: REQUEST.requestId,
      status: "success",
      revokedCount: 2,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(REQUEST);
  });

  it("rejects an invalid Manager token without calling the Site handler", async () => {
    const handler = vi.fn<SessionRevocationHandler>(() => ({
      kind: "success",
      record: { ...REQUEST, receivedAt: "2026-08-31T00:00:01.000Z", revokedCount: 0 },
    }));

    await request(app(handler))
      .post("/internal/v1/sessions/revoke")
      .set("Authorization", "Bearer wrong-token")
      .send(REQUEST)
      .expect(401);

    expect(handler).not.toHaveBeenCalled();
  });
});
