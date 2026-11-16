import { runRateLimitComparison } from "./rate-limit-comparison.js";

runRateLimitComparison().then((result) => {
  console.log(`Rate-limit comparison: ${result.conditions.length} conditions, expected=${result.passed}`);
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
