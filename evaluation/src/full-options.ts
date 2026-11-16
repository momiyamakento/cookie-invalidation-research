import { parseLoadProfile } from "./benchmark-load.js";
import type { FullConfig, Condition } from "./full-types.js";
const counts = [1, 5, 10, 20, 50, 100];
function number(key: string, value: string | undefined, min: number, max: number) {
  if (value === undefined || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${key}: expected integer ${min}..${max}`);
  return Number(value);
}
export function parseFullOptions(argv: readonly string[]) {
  const config: FullConfig = { experiment: "all", serviceCounts: counts, loadProfiles: ["light", "medium", "heavy"], serviceDelays: [0, 20, 100], warmup: 5, trials: 30, order: "sequential", seed: 20260914, cooldownMs: 2000, timeoutMs: 15000 };
  let resume: string | undefined; let dryRun = false; let overrides = false;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (seen.has(key)) throw new Error(`Repeated argument: ${key}`); seen.add(key);
    if (key === "--dry-run") { dryRun = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`);
    if (key === "--resume") { resume = value; continue; }
    overrides = true;
    if (key === "--experiment") { if (!["processing", "delay", "all"].includes(value)) throw new Error("Invalid experiment"); config.experiment = value as FullConfig["experiment"]; }
    else if (key === "--order") { if (!["sequential", "randomized"].includes(value)) throw new Error("Invalid order"); config.order = value as FullConfig["order"]; }
    else if (key === "--service-counts") { config.serviceCounts = [...new Set(value.split(",").map((v) => number(key, v, 1, 100)))]; if (config.serviceCounts.some((n) => !counts.includes(n))) throw new Error("Unsupported service count"); }
    else if (key === "--load-profiles") config.loadProfiles = [...new Set(value.split(",").map(parseLoadProfile))];
    else if (key === "--service-delays") { config.serviceDelays = [...new Set(value.split(",").map((v) => number(key, v, 0, 100)))]; if (config.serviceDelays.some((n) => ![0,20,100].includes(n))) throw new Error("Unsupported delay"); }
    else if (key === "--warmup") config.warmup = number(key, value, 0, 100);
    else if (key === "--trials") config.trials = number(key, value, 1, 10000);
    else if (key === "--seed") config.seed = number(key, value, 0, 0xffffffff);
    else if (key === "--cooldown-ms") config.cooldownMs = number(key, value, 0, 60000);
    else if (key === "--timeout-ms") config.timeoutMs = number(key, value, 1, 300000);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (resume && overrides) throw new Error("Resume uses the saved configuration; overrides are forbidden.");
  return { config, resume, dryRun };
}
export function generateConditions(config: FullConfig): Condition[] {
  const rows: Condition[] = [];
  const add = (experimentType: "A" | "B", serviceCount: number, loadProfile: Condition["loadProfile"], serviceDelayMs: number) => rows.push({ experimentType, conditionId: `${experimentType}-${serviceCount}-${loadProfile}-${serviceDelayMs}`, serviceCount, loadProfile, serviceDelayMs, executionOrder: 0 });
  if (config.experiment !== "delay") for (const n of config.serviceCounts) for (const p of config.loadProfiles) add("A", n, p, 0);
  if (config.experiment !== "processing") for (const n of config.serviceCounts) for (const d of config.serviceDelays) add("B", n, "medium", d);
  if (config.order === "randomized") {
    // Mulberry32 + Fisher-Yates; algorithm and seed saved for reproducible order.
    let state = config.seed >>> 0;
    const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [rows[i], rows[j]] = [rows[j]!, rows[i]!]; }
  }
  return rows.map((row, i) => ({ ...row, executionOrder: i + 1 }));
}
