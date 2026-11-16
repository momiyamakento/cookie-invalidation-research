import type { DemoConfig } from "./config.js";
import type { DemoSession } from "./demo-session.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function time(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
export function revocationEvent(session: DemoSession, key: string, message: string, at = new Date().toISOString()) {
  if (session.events.some((event) => event.key === key)) return;
  session.events.push({ key, at, message });
  session.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  session.events = session.events.slice(-80);
}

/** Only existing HTTP APIs are used; never reads or mutates a research database. */
export async function useDecoy(config: DemoConfig, session: DemoSession, value: string) {
  const a = config.sites.find((site) => site.id === "site-a")!;
  const state = session.revocation;
  state.attempted = true; state.error = null;
  try {
    const response = await fetch(`${a.baseUrl}/__research/decoy-use`, {
      method: "GET", headers: { Cookie: `decoy_site_a=${value}` },
      redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    const data = object(await response.json());
    if (!response.ok || data.serviceId !== "site-a" || data.localUserId !== a.localUserId ||
      typeof data.eventId !== "string" || !/^[0-9a-f-]{36}$/iu.test(data.eventId) || !time(data.detectedAt) ||
      !["detected", "already_detected"].includes(String(data.status))) throw new Error("detection");
    state.eventId = data.eventId; state.detectedAt = time(data.detectedAt);
    state.notification = data.notificationStatus === "notified" ? "notified" : "failed";
    revocationEvent(session, `${state.eventId}:detected`, "Service Aが囮Cookieの使用を検知（実記録）", state.detectedAt!);
    if (state.notification === "failed") {
      revocationEvent(session, `${state.eventId}:notification-failed`, "Managementへの通知の成功を確認できませんでした（応答確認）");
    }
  } catch {
    state.error = "囮Cookieの検知応答を確認できません。処理が実行された可能性があるため、状態を確認してから同じCookieで再試行してください。";
  }
}

export async function readRevocation(config: DemoConfig, session: DemoSession) {
  const state = session.revocation;
  if (!state.eventId) return;
  try {
    const response = await fetch(`${config.managementBaseUrl}/api/v1/detections/${encodeURIComponent(state.eventId)}`, {
      headers: { Authorization: `Bearer ${config.managementAuthTokens["site-a"] ?? ""}` },
      redirect: "manual", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("management");
    const data = object(await response.json());
    const invalidation = object(data.invalidation);
    const targets = Array.isArray(invalidation.targets) ? invalidation.targets.map(object) : [];
    if (data.eventId !== state.eventId || data.sourceServiceId !== "site-a" ||
      data.sourceLocalUserId !== config.sites.find((site) => site.id === "site-a")!.localUserId ||
      typeof data.principalId !== "string" || !time(data.receivedAt) ||
      !["RESOLVED", "PROCESSING", "SUCCESS", "PARTIAL_FAILURE", "FAILED"].includes(String(data.status)) ||
      targets.some((target) => typeof target.serviceId !== "string" || typeof target.localUserId !== "string" ||
        !["PENDING", "SUCCESS", "FAILED"].includes(String(target.status)))) throw new Error("result");
    state.principalId = data.principalId;
    state.managerStatus = String(data.status);
    state.targets = targets.map((target) => ({ serviceId: String(target.serviceId), localUserId: String(target.localUserId), status: String(target.status) }));
    state.totalDurationMs = typeof data.totalDurationMs === "number" && Number.isFinite(data.totalDurationMs) && data.totalDurationMs >= 0 ? data.totalDurationMs : null;
    state.error = null;
    revocationEvent(session, `${state.eventId}:received`, "Management Serverが検知通知を受信（実記録）", time(data.receivedAt)!);
    if (targets.length) revocationEvent(session, `${state.eventId}:targets`, `${targets.length}サービスを失効対象として確認（結果取得時）`);
    if (time(data.completedAt)) revocationEvent(session, `${state.eventId}:finished`,
      data.status === "SUCCESS" ? "Managementの一括失効処理が完了（実記録）" : "Managementの一括失効処理が終了。一部または全件の失敗あり（実記録）", time(data.completedAt)!);
  } catch {
    // Do not let a previous success masquerade as a freshly verified result.
    state.error = "Managementの処理結果を取得できません。通知・接続状態を確認してください。";
  }
}
