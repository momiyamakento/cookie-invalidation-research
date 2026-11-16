import { parseLoadProfile, validateServiceDelay, type LoadProfile } from "./benchmark-load.js";

export interface BenchmarkScaleOptions { serviceCounts: number[]; warmup: number; trials: number; timeoutMs: number; loadProfile: LoadProfile; serviceDelayMs: number; }
function integer(name: string, value: string | undefined): number { if (value === undefined || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a non-negative safe integer.`); return Number(value); }
export function parseBenchmarkScaleOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): BenchmarkScaleOptions {
  let serviceCounts = [1, 5, 10, 20, 50, 100]; let warmup = 5; let trials = 30; let timeoutMs = 15_000;
  let profile = env.SERVICE_LOAD_PROFILE;
  let serviceDelayMs = 0;
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (key === "--service-counts") {
      if (value === undefined || !/^\d+(,\d+)*$/u.test(value)) throw new Error("--service-counts must be comma-separated positive integers.");
      serviceCounts = [...new Set(value.split(",").map((v) => integer(key, v)))];
      if (serviceCounts.some((n) => n < 1)) throw new Error("--service-counts must be positive.");
    } else if (key === "--warmup") warmup = integer(key, value);
    else if (key === "--trials") trials = integer(key, value);
    else if (key === "--timeout-ms") { timeoutMs = integer(key, value); if (timeoutMs < 1) throw new Error("--timeout-ms must be positive."); }
    else if (key === "--load-profile") { if (value === undefined) throw new Error("--load-profile requires a value."); profile = value; }
    else if (key === "--service-delay-ms") serviceDelayMs = validateServiceDelay(integer(key, value));
    else throw new Error(`Unknown benchmark argument: ${key ?? ""}`);
  }
  if (trials < 1) throw new Error("--trials must be at least 1.");
  return { serviceCounts, warmup, trials, timeoutMs, loadProfile: parseLoadProfile(profile), serviceDelayMs };
}
