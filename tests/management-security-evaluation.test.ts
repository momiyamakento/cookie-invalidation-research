import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runManagementSecurityEvaluation } from "../evaluation/src/management-security-cli.js";

describe("management API security evaluation", () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it("blocks unauthenticated and cross-service attacks while recording the stolen-token residual risk", async () => {
    const directory = mkdtempSync(join(tmpdir(), "management-security-"));
    directories.push(directory);
    const result = await runManagementSecurityEvaluation(directory);

    expect(result.passed).toBe(true);
    expect(result.cases).toHaveLength(9);
    expect(result.audit).toEqual({ total: 9, allowed: 3, denied: 6 });
    expect(result.cases.filter((item) => item.outcome === "BLOCKED").map((item) => item.id)).toEqual([
      "M1", "M2", "M3", "M5", "D1", "D2",
    ]);
    expect(result.cases.find((item) => item.id === "R1")).toMatchObject({
      actualStatus: 201,
      outcome: "ALLOWED",
      stateBefore: 1,
      stateAfter: 2,
    });
    expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("正規通知と区別できない残存リスク");
    expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("監査ログ：全9件（許可3件、拒否6件）");
    expect(readFileSync(join(directory, "summary.csv"), "utf8")).not.toContain(TOKENS_FORBIDDEN_PATTERN);
  });
});

const TOKENS_FORBIDDEN_PATTERN = "evaluation-site-a-token";
