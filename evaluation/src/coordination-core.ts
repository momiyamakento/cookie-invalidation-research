export interface Access {
  key: string; serviceId: string; role: "target" | "control"; source: boolean;
  due: number; start: number | null; end: number | null; status: number; error: string | null;
}
export function accessPlan(items: Array<{ key: string; role: "target" | "control" }>, windowMs: number, interval: number) {
  const targets = items.filter((s) => s.role === "target");
  const controls = items.filter((s) => s.role === "control");
  const plan: Array<{ key: string; due: number }> = [];
  for (const group of [targets, controls]) {
    const period = group === targets ? interval : 1000;
    group.forEach((s, i) => {
      for (let due = i * period / group.length; due < windowMs; due += period) plan.push({ key: s.key, due });
    });
  }
  return plan.sort((a, b) => a.due - b.due || a.key.localeCompare(b.key));
}
export function summarizeAccess(rows: Access[], keys: string[], windowMs: number) {
  const set = new Set(keys); const selected = rows.filter((r) => set.has(r.key));
  const timings = keys.map((key) => {
    const own = selected.filter((r) => r.key === key);
    const successes = own.filter((r) => r.status === 200 && r.start !== null);
    const refusals = own.filter((r) => r.status === 401 && r.end !== null && r.end <= windowMs);
    const first = refusals.length ? Math.min(...refusals.map((r) => r.end!)) : null;
    return { key, first401Ms: first, last200EndMs: successes.length ? Math.max(...successes.map((r) => r.end!)) : null,
      acceptedAfter401: first === null ? 0 : successes.filter((r) => r.start! > first).length };
  });
  return { planned: selected.length, sent: selected.filter((r) => r.start !== null).length,
    accepted: selected.filter((r) => r.status === 200).length,
    denied: selected.filter((r) => r.status === 401).length,
    unknown: selected.filter((r) => r.status !== 200 && r.status !== 401).length,
    successfulServices: new Set(selected.filter((r) => r.status === 200).map((r) => r.serviceId)).size,
    allDeniedMs: timings.every((t) => t.first401Ms !== null) ? Math.max(...timings.map((t) => t.first401Ms!)) : null,
    timings };
}
