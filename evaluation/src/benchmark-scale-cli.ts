import { runBenchmarkScale } from "./benchmark-scale.js";
runBenchmarkScale(process.argv.slice(2)).then(({ directory }) => console.log(`Benchmark results: ${directory}`)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Benchmark failed."); process.exitCode = 1; });
