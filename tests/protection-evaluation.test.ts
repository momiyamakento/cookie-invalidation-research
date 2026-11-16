import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";
import { createProtectionFixture, type FaultMode } from "../evaluation/src/protection-fixture.js";
import { revokeSiteSessions } from "../apps/management-server/src/site-revocation-client.js";

const secret = "test-protection-fixture-secret";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((ok, bad) => server.close((error) => error ? bad(error) : ok()));
  }
});

async function fixture(mode: FaultMode) {
  const server = createProtectionFixture("benchmark-001", secret).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((ok) => server.once("listening", ok));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Invalid address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const reset = await fetch(`${baseUrl}/control/reset`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  const { cookie } = await reset.json() as { cookie: string };
  const access = async () => {
    const response = await fetch(`${baseUrl}/protected`, { headers: { Cookie: cookie } });
    await response.arrayBuffer();
    return response.status;
  };
  const state = async () => {
    const response = await fetch(`${baseUrl}/control/state`, { headers: { Authorization: `Bearer ${secret}` } });
    return await response.json() as { active: boolean; attempts: number; mutations: number; uniqueRequests: number };
  };
  const input = { baseUrl, authToken: deriveBenchmarkToken(secret, "benchmark-001"), request: { requestId: randomUUID(), eventId: randomUUID(), localUserId: "protection-user", reason: "DECOY_COOKIE_DETECTED" as const, detectedAt: new Date().toISOString() } };
  return { baseUrl, access, state, input };
}

describe("protection evaluation fault semantics", () => {
  it("rejects unauthorized revocation and performs one mutation for duplicate requests", async () => {
    const f = await fixture("healthy");
    expect(await f.access()).toBe(200);
    expect((await revokeSiteSessions({ ...f.input, authToken: "wrong" })).ok).toBe(false);
    expect(await f.access()).toBe(200);
    expect((await revokeSiteSessions(f.input)).ok).toBe(true);
    expect(await f.access()).toBe(401);
    expect((await revokeSiteSessions(f.input)).ok).toBe(true);
    expect(await f.state()).toMatchObject({ active: false, attempts: 2, mutations: 1, uniqueRequests: 1 });
  });
  it.each(["before", "after"] as const)("distinguishes %s-commit timeout from cookie state", async (mode) => {
    const f = await fixture(mode);
    expect(await f.access()).toBe(200);
    const result = await revokeSiteSessions(f.input, { timeoutMs: 80, retryDelayMs: 5 });
    expect(result).toMatchObject({ ok: false, attempts: 3, httpStatus: null });
    expect(await f.access()).toBe(mode === "before" ? 200 : 401);
    expect(await f.state()).toMatchObject({ active: mode === "before", attempts: 3, mutations: mode === "before" ? 0 : 1, uniqueRequests: mode === "before" ? 0 : 1 });
  });
  it("does not allow unauthenticated fixture reset", async () => {
    const f = await fixture("healthy");
    const response = await fetch(`${f.baseUrl}/control/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "before" }) });
    await response.arrayBuffer();
    expect(response.status).toBe(401);
  });
});
