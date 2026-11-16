import { runBenchmarkScale } from "./benchmark-scale.js";

// Fixed entry point. Arguments are generated from validated values by the demo server.
runBenchmarkScale(process.argv.slice(2)).then(({ directory }) => {
  process.send?.({ directory });
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Benchmark failed.");
  process.exitCode = 1;
}).finally(() => { process.disconnect?.(); });
