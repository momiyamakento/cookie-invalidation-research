import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { createManagementApp } from "../../apps/management-server/src/app.js";
import { SiteTokenAuthenticator } from "../../apps/management-server/src/internal-auth.js";
import { initializeManagementContext } from "../../apps/management-server/src/management-context.js";
import { DetectionRateLimiter } from "../../apps/management-server/src/detection-rate-limiter.js";

type Outcome = "BLOCKED" | "ALLOWED";

export interface SecurityCaseResult {
  id: string;
  threat: string;
  credential: string;
  expectedStatus: number;
  actualStatus: number;
  stateBefore: number;
  stateAfter: number;
  outcome: Outcome;
  interpretation: string;
}

export interface ManagementSecurityResult {
  generatedAt: string;
  cases: SecurityCaseResult[];
  audit: { total: number; allowed: number; denied: number };
  passed: boolean;
}

const TOKENS = {
  "site-a": "evaluation-site-a-token",
  "site-b": "evaluation-site-b-token",
  "site-c": "evaluation-site-c-token",
  "site-d": "evaluation-site-d-token",
} as const;

function csv(value: unknown): string {
  const text = String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function markdown(result: ManagementSecurityResult): string {
  const rows = result.cases.map((item) =>
    `| ${item.id} | ${item.threat} | ${item.credential} | ${item.actualStatus} | ${item.stateBefore}→${item.stateAfter} | ${item.outcome} | ${item.interpretation} |`,
  ).join("\n");
  return `# Management API安全性評価（自動生成）

生成日時：${result.generatedAt}

## 脅威モデル

| 攻撃者 | 能力 | 本評価で確認すること |
|---|---|---|
| 外部攻撃者 | Bearer資格情報を持たず、管理APIへHTTP要求できる | 対応表変更・検知イベント作成を拒否する |
| 単一サービス侵害者 | 1サービスのBearer資格情報を取得している | 他サービスへのなりすましを拒否する |
| 資格情報窃取者 | 正しいサービスのBearer資格情報と利用者IDを取得している | 正規通知と区別できず受理される残存リスクを確認する |
| 管理ホスト侵害者 | 管理プロセス・DB・送信用資格情報を操作できる | 今回のAPI認証では防げないため実験対象外 |

## 結果

| ID | シナリオ | 資格情報 | HTTP | 状態件数 | 判定 | 解釈 |
|---|---|---|---:|---:|---|---|
${rows}

全ケースが想定結果と一致：${result.passed ? "はい" : "いいえ"}

監査ログ：全${result.audit.total}件（許可${result.audit.allowed}件、拒否${result.audit.denied}件）

## 結論

未認証要求とサービス間の権限越境は401/403で阻止され、拒否時に対応表・検知イベントは変更されない。正しいサービス資格情報による単発の偽通知は受理されるが、時間窓内の新規イベント上限を超えた通知は429で拒否された。レート制限は単発攻撃を防がず、正規通知の集中も制限し得るため、上限値の比較評価が必要である。
`;
}

export async function runManagementSecurityEvaluation(
  outputDirectory = resolve("evaluation", "results", `management-security-${new Date().toISOString().replaceAll(":", "-")}`),
): Promise<ManagementSecurityResult> {
  await mkdir(outputDirectory, { recursive: true });
  const databasePath = resolve(outputDirectory, "management-security.sqlite");
  const context = initializeManagementContext(databasePath);
  const app = createManagementApp(context.mappingService, {
    authenticator: new SiteTokenAuthenticator(TOKENS),
    detectionService: context.detectionService,
    securityAuditRepository: context.securityAuditRepository,
    detectionRateLimiter: new DetectionRateLimiter(2, 60_000),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done, fail) => {
    server.once("listening", done);
    server.once("error", fail);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cases: SecurityCaseResult[] = [];
  let audit: ManagementSecurityResult["audit"];
  const count = (table: "user_service_mappings" | "detection_events"): number =>
    context.database.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
  const request = async (
    input: Omit<SecurityCaseResult, "actualStatus" | "stateBefore" | "stateAfter" | "outcome"> & {
      table: "user_service_mappings" | "detection_events";
      path: string;
      init?: RequestInit;
      expectedMutation: boolean;
    },
  ): Promise<Response> => {
    const before = count(input.table);
    const response = await fetch(`${baseUrl}${input.path}`, { ...input.init, signal: AbortSignal.timeout(2_000) });
    await response.clone().arrayBuffer();
    const after = count(input.table);
    const statusMatches = response.status === input.expectedStatus;
    const mutationMatches = input.expectedMutation ? after > before : after === before;
    cases.push({ id: input.id, threat: input.threat, credential: input.credential,
      expectedStatus: input.expectedStatus, actualStatus: response.status, stateBefore: before, stateAfter: after,
      outcome: response.status >= 400 ? "BLOCKED" : "ALLOWED", interpretation: input.interpretation });
    if (!statusMatches || !mutationMatches) throw new Error(`${input.id} did not match the frozen expectation.`);
    return response;
  };
  const json = (body: object, authorization?: string): RequestInit => ({
    method: "POST",
    headers: authorization === undefined ? { "Content-Type": "application/json" } :
      { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const mappingA = { principalId: "security-principal-001", serviceId: "site-a", localUserId: "security-user-a" };
  const detection = (serviceId: "site-a" | "site-b", localUserId: string) => ({
    eventId: randomUUID(), serviceId, localUserId, decoyId: randomUUID(), detectedAt: new Date().toISOString(),
  });

  try {
    await request({ id: "M1", threat: "未認証の対応表登録", credential: "なし", expectedStatus: 401,
      table: "user_service_mappings", path: "/api/v1/mappings", init: json(mappingA), expectedMutation: false,
      interpretation: "認証なしの書込みを拒否" });
    await request({ id: "M2", threat: "不正トークンで対応表登録", credential: "不正", expectedStatus: 401,
      table: "user_service_mappings", path: "/api/v1/mappings", init: json(mappingA, "Bearer invalid"), expectedMutation: false,
      interpretation: "未知の資格情報を拒否" });
    await request({ id: "M3", threat: "Site AがSite Bとして登録", credential: "Site A", expectedStatus: 403,
      table: "user_service_mappings", path: "/api/v1/mappings",
      init: json({ ...mappingA, serviceId: "site-b", localUserId: "security-user-b" }, `Bearer ${TOKENS["site-a"]}`), expectedMutation: false,
      interpretation: "サービス間の権限越境を拒否" });
    await request({ id: "M4", threat: "正規のSite A登録", credential: "Site A", expectedStatus: 201,
      table: "user_service_mappings", path: "/api/v1/mappings", init: json(mappingA, `Bearer ${TOKENS["site-a"]}`), expectedMutation: true,
      interpretation: "正規処理は維持" });
    context.mappingService.register({ principalId: mappingA.principalId, serviceId: "site-b", localUserId: "security-user-b" });
    await request({ id: "M5", threat: "Site AがSite Bを逆引き", credential: "Site A", expectedStatus: 403,
      table: "user_service_mappings", path: "/api/v1/mappings/resolve?serviceId=site-b&localUserId=security-user-b",
      init: { headers: { Authorization: `Bearer ${TOKENS["site-a"]}` } }, expectedMutation: false,
      interpretation: "他サービスの識別情報を開示しない" });
    await request({ id: "D1", threat: "未認証の検知通知", credential: "なし", expectedStatus: 401,
      table: "detection_events", path: "/api/v1/detections", init: json(detection("site-a", "security-user-a")), expectedMutation: false,
      interpretation: "強制失効の起点を作成させない" });
    await request({ id: "D2", threat: "Site AがSite Bの検知を偽装", credential: "Site A", expectedStatus: 403,
      table: "detection_events", path: "/api/v1/detections",
      init: json(detection("site-b", "security-user-b"), `Bearer ${TOKENS["site-a"]}`), expectedMutation: false,
      interpretation: "通知元サービスのなりすましを拒否" });
    await request({ id: "D3", threat: "正規のSite A検知通知", credential: "Site A", expectedStatus: 201,
      table: "detection_events", path: "/api/v1/detections",
      init: json(detection("site-a", "security-user-a"), `Bearer ${TOKENS["site-a"]}`), expectedMutation: true,
      interpretation: "正規の失効ワークフローは維持" });
    await request({ id: "R1", threat: "窃取したSite A資格情報で偽通知", credential: "窃取Site A", expectedStatus: 201,
      table: "detection_events", path: "/api/v1/detections",
      init: json(detection("site-a", "security-user-a"), `Bearer ${TOKENS["site-a"]}`), expectedMutation: true,
      interpretation: "正規通知と区別できない残存リスク" });
    await request({ id: "R2", threat: "窃取資格情報で上限超過の偽通知", credential: "窃取Site A", expectedStatus: 429,
      table: "detection_events", path: "/api/v1/detections",
      init: json(detection("site-a", "security-user-a"), `Bearer ${TOKENS["site-a"]}`), expectedMutation: false,
      interpretation: "時間窓内の新規イベント上限で被害拡大を制限" });
    const auditRecords = context.securityAuditRepository.findAll();
    audit = {
      total: auditRecords.length,
      allowed: auditRecords.filter((item) => item.outcome === "ALLOWED").length,
      denied: auditRecords.filter((item) => item.outcome === "DENIED").length,
    };
  } finally {
    await new Promise<void>((done, fail) => server.close((error) => error === undefined ? done() : fail(error)));
    context.database.close();
  }

  const result: ManagementSecurityResult = {
    generatedAt: new Date().toISOString(),
    cases,
    audit,
    passed: cases.length === 10 && audit.total === 10 && audit.allowed === 3 && audit.denied === 7,
  };
  const headers = ["id", "threat", "credential", "expected_status", "actual_status", "state_before", "state_after", "outcome", "interpretation"];
  const csvRows = cases.map((item) => [item.id, item.threat, item.credential, item.expectedStatus, item.actualStatus,
    item.stateBefore, item.stateAfter, item.outcome, item.interpretation].map(csv).join(","));
  await writeFile(resolve(outputDirectory, "summary.csv"), `${headers.join(",")}\n${csvRows.join("\n")}\n`);
  await writeFile(resolve(outputDirectory, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, "report.md"), markdown(result));
  return result;
}

