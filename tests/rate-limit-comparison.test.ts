import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runRateLimitComparison } from "../evaluation/src/rate-limit-comparison.js";

describe("rate-limit comparison evaluation", () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it("quantifies attack reduction and legitimate burst rejection at four thresholds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rate-limit-comparison-"));
    directories.push(directory);
    const result = await runRateLimitComparison(directory);

    expect(result.passed).toBe(true);
    expect(result.conditions).toHaveLength(8);
    expect(result.conditions.filter((item) => item.workload === "legitimate").map((item) => ({
      threshold: item.threshold, accepted: item.accepted, rateLimited: item.rateLimited,
    }))).toEqual([
      { threshold: 1, accepted: 1, rateLimited: 2 },
      { threshold: 2, accepted: 2, rateLimited: 1 },
      { threshold: 5, accepted: 3, rateLimited: 0 },
      { threshold: 10, accepted: 3, rateLimited: 0 },
    ]);
    expect(result.conditions.filter((item) => item.workload === "stolen-token-attack").map((item) => item.accepted)).toEqual([1, 2, 5, 10]);
    expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("攻撃抑制と可用性のトレードオフ");
  });
});
