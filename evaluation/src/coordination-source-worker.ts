import { randomUUID } from "node:crypto";
import { COMPONENTS } from "@cookie-research/protocol";
import { createDetectionNotifier, type DetectionNotifier } from "@cookie-research/service-kit";
import { initializeResearchSiteContext } from "../../packages/service-kit/src/research-site/runtime.js";
import { createResearchSiteApp } from "../../packages/service-kit/src/research-site/app.js";

async function main() {
const [path, managerUrl, arm] = process.argv.slice(2);
if (!path || !managerUrl || !["local", "coordinated"].includes(arm ?? "")) throw new Error("Invalid source worker arguments");
const password = randomUUID();
const context = await initializeResearchSiteContext({ component: COMPONENTS.siteB,
  localUserId: "source-target", username: "target", sessionCookieName: "sid_source", decoyCookieName: "decoy_source" }, path, password);
context.userRepository.insertIfAbsent({ id: "source-control", username: "control", passwordHash: context.fallbackPasswordHash, createdAt: new Date().toISOString() });
const remote = createDetectionNotifier({ managementBaseUrl: managerUrl, serviceId: "site-b", authToken: "scale-b-token" });
const notices: unknown[] = [];
const notifier: DetectionNotifier = async (event) => {
  const local = await context.sessionRevocationHandler({ requestId: `local-${event.eventId}`, eventId: event.eventId,
    localUserId: event.localUserId, reason: "DECOY_COOKIE_DETECTED", detectedAt: event.detectedAt });
  if (local.kind !== "success" && local.kind !== "already_processed") throw new Error("Local revocation failed");
  const result = arm === "coordinated" ? await remote(event) : {
    ok: true as const, status: "SUCCESS" as const, attempts: 0,
    response: { eventId: event.eventId, principalId: "target", status: "SUCCESS" as const, targets: [] },
  };
  notices.push({ event, local, result });
  return result;
};
const app = createResearchSiteApp(context, notifier, "scale-mb-token");
const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  process.send?.({ id: "ready", data: { port: address.port, password } });
});
process.on("message", (raw: unknown) => {
  const message = raw as { id: string; command: string };
  if (message.command !== "state") return;
  process.send?.({ id: message.id, data: {
    sessions: context.database.prepare("SELECT id,user_id,status FROM sessions ORDER BY id").all(),
    events: context.database.prepare("SELECT * FROM local_detection_events").all(),
    requests: context.database.prepare("SELECT * FROM invalidation_requests").all(), notices,
  } });
});
process.on("disconnect", () => { server.closeAllConnections(); server.close(); context.database.close(); });
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
