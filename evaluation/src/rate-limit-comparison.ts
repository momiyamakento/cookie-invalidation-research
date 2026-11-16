import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { createManagementApp } from "../../apps/management-server/src/app.js";
import { DetectionRateLimiter } from "../../apps/management-server/src/detection-rate-limiter.js";
import { SiteTokenAuthenticator } from "../../apps/management-server/src/internal-auth.js";
import { initializeManagementContext } from "../../apps/management-server/src/management-context.js";

const TOKEN = "rate-limit-comparison-site-a";
const THRESHOLDS = [1, 2, 5, 10] as const;

export interface RateLimitConditionResult {
  threshold: number;
  workload: "legitimate" | "stolen-token-attack";
  sent: number;
  accepted: number;
  rateLimited: number;
  unexpected: number;
  persisted: number;
  auditAllowed: number;
  auditDenied: number;
  meanResponseMs: number;
  maxResponseMs: number;
}

export interface RateLimitComparisonResult {
  generatedAt: string;
  windowMs: number;
  legitimateBurst: number;
  attackBurst: number;
  conditions: RateLimitConditionResult[];
  passed: boolean;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function condition(
  threshold: number,
  workload: RateLimitConditionResult["workload"],
  sent: number,
): Promise<RateLimitConditionResult> {
  const context = initializeManagementContext(":memory:");
  context.mappingService.register({
    principalId: "rate-limit-principal",
    serviceId: "site-a",
    localUserId: "rate-limit-user",
  });
  const app = createManagementApp(context.mappingService, {
    authenticator: new SiteTokenAuthenticator({ "site-a": TOKEN }),
    detectionService: context.detectionService,
    detectionRateLimiter: new DetectionRateLimiter(threshold, 60_000),
    securityAuditRepository: context.securityAuditRepository,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done, fail) => {
    server.once("listening", done);
    server.once("error", fail);
  });
  const address = server.address() as AddressInfo;
  const statuses: number[] = [];
  const durations: number[] = [];
  try {
    for (let index = 0; index < sent; index += 1) {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/detections`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: randomUUID(),
          serviceId: "site-a",
          localUserId: "rate-limit-user",
          decoyId: randomUUID(),
          detectedAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(2_000),
      });
      await response.arrayBuffer();
      durations.push(performance.now() - started);
      statuses.push(response.status);
      if (response.status === 429 && response.headers.get("retry-after") === null) {
        throw new Error("A rate-limited response did not include Retry-After.");
      }
    }
    const audits = context.securityAuditRepository.findAll();
    const persisted = context.database.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM detection_events",
    ).get()?.count ?? 0;
    return {
      threshold,
      workload,
      sent,
      accepted: statuses.filter((status) => status === 201).length,
      rateLimited: statuses.filter((status) => status === 429).length,
      unexpected: statuses.filter((status) => status !== 201 && status !== 429).length,
      persisted,
      auditAllowed: audits.filter((item) => item.outcome === "ALLOWED").length,
      auditDenied: audits.filter((item) => item.outcome === "DENIED").length,
      meanResponseMs: average(durations),
      maxResponseMs: Math.max(...durations),
    };
  } finally {
    await new Promise<void>((done, fail) => server.close((error) => error === undefined ? done() : fail(error)));
    context.database.close();
  }
}

function csv(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function report(result: RateLimitComparisonResult): string {
  const rows = result.conditions.map((item) =>
    `| ${item.threshold} | ${item.workload} | ${item.sent} | ${item.accepted} | ${item.rateLimited} | ${item.meanResponseMs.toFixed(2)} |`,
  ).join("\n");
  return `# 検知通知レート制限の比較評価（自動生成）

生成日時：${result.generatedAt}

時間窓：${result.windowMs / 1_000}秒。正規バースト${result.legitimateBurst}件、窃取トークン攻撃${result.attackBurst}件。各条件は独立したManagement ServerとメモリDBを使用した。

| 上限 | ワークロード | 送信 | 許可 | 429 | 平均応答ms |
|---:|---|---:|---:|---:|---:|
${rows}

全条件でHTTP結果、DB保存件数、監査ログ件数が一致：${result.passed ? "はい" : "いいえ"}

上限を小さくすると窃取トークン攻撃による許可件数は減るが、正規通知の集中も429にする。これは攻撃抑制と可用性のトレードオフであり、本評価だけから実運用の最適値は決定しない。
`;
}

export async function runRateLimitComparison(
  outputDirectory = resolve("evaluation", "results", `rate-limit-comparison-${new Date().toISOString().replaceAll(":", "-")}`),
): Promise<RateLimitComparisonResult> {
  await mkdir(outputDirectory, { recursive: true });
  const conditions: RateLimitConditionResult[] = [];
  for (const threshold of THRESHOLDS) {
    conditions.push(await condition(threshold, "legitimate", 3));
    conditions.push(await condition(threshold, "stolen-token-attack", 20));
  }
  const passed = conditions.every((item) =>
    item.accepted === Math.min(item.threshold, item.sent) &&
    item.rateLimited === Math.max(0, item.sent - item.threshold) &&
    item.unexpected === 0 && item.persisted === item.accepted &&
    item.auditAllowed === item.accepted && item.auditDenied === item.rateLimited,
  );
  const result: RateLimitComparisonResult = {
    generatedAt: new Date().toISOString(),
    windowMs: 60_000,
    legitimateBurst: 3,
    attackBurst: 20,
    conditions,
    passed,
  };
  const header = "threshold,workload,sent,accepted,rate_limited,unexpected,persisted,audit_allowed,audit_denied,mean_response_ms,max_response_ms";
  const rows = conditions.map((item) => [item.threshold, item.workload, item.sent, item.accepted, item.rateLimited,
    item.unexpected, item.persisted, item.auditAllowed, item.auditDenied, item.meanResponseMs, item.maxResponseMs].map(csv).join(","));
  await writeFile(resolve(outputDirectory, "summary.csv"), `${header}\n${rows.join("\n")}\n`);
  await writeFile(resolve(outputDirectory, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, "report.md"), report(result));
  if (!passed) throw new Error("Rate-limit comparison did not satisfy the frozen consistency checks.");
  return result;
}
