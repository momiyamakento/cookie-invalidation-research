import { writeFile } from "node:fs/promises";

import {
  EVALUATION_CSV_COLUMNS,
  type EvaluationRecord,
} from "./types.js";

function escapeCsv(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function evaluationCsv(records: readonly EvaluationRecord[]): string {
  const lines = [EVALUATION_CSV_COLUMNS.join(",")];
  for (const record of records) {
    lines.push(
      EVALUATION_CSV_COLUMNS.map((column) => escapeCsv(record[column])).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeEvaluationCsv(
  path: string,
  records: readonly EvaluationRecord[],
): Promise<void> {
  await writeFile(path, evaluationCsv(records), { encoding: "utf8", flag: "wx" });
}
