export interface EvaluationOptions {
  trials: number;
  warmup: number;
}

function nonNegativeInteger(name: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return Number.parseInt(value, 10);
}

export function parseEvaluationOptions(argv: readonly string[]): EvaluationOptions {
  let trials = 10;
  let warmup = 3;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--trials") {
      trials = nonNegativeInteger("--trials", argv[index + 1]);
      index += 1;
    } else if (argument === "--warmup") {
      warmup = nonNegativeInteger("--warmup", argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown evaluation argument: ${argument ?? ""}`);
    }
  }
  if (trials < 1) throw new Error("--trials must be at least 1.");
  return { trials, warmup };
}
