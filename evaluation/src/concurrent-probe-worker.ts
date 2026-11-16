import { setTimeout as delay } from "node:timers/promises";
import type { Probe, Session } from "./concurrent-types.js";

interface Input { sessions: Session[]; targets: string[]; start: number; deadline: number; interval: number; limit: number }
let running = false;
async function observe(input: Input): Promise<Probe[]> {
  await delay(Math.max(0, input.start - performance.now()));
  const targets = new Set(input.targets);
  const states = input.sessions.filter((s) => targets.has(s.principalId) || s.principalId.startsWith("control-")).map((session) => ({ session,
    due: input.start + (targets.has(session.principalId) ? 0 : 1000), busy: false, denied: false }));
  const probes: Probe[] = [];
  const active = new Set<Promise<void>>();
  while (performance.now() < input.deadline) {
    if (states.filter((s) => targets.has(s.session.principalId)).every((s) => s.denied)) break;
    const now = performance.now();
    const ready = states.filter((s) => !s.busy && !s.denied && s.due <= now).sort((a, b) => a.due - b.due);
    for (const state of ready) {
      if (active.size >= input.limit) break;
      state.busy = true;
      const start = performance.now(); const due = state.due;
      const task = (async () => {
        let status = 0; let localUserId: string | null = null; let error: string | null = null;
        try {
          const response = await fetch(`${state.session.baseUrl}/protected`, { headers: { Cookie: state.session.cookie }, signal: AbortSignal.timeout(2000) });
          const body = await response.json() as { localUserId?: string };
          status = response.status; localUserId = body.localUserId ?? null;
        } catch (e) { error = e instanceof Error ? e.name : String(e); }
        probes.push({ sessionId: state.session.sessionId, start, end: performance.now(), status, localUserId, error, due });
        state.denied = targets.has(state.session.principalId) && status === 401;
        state.due = performance.now() + (targets.has(state.session.principalId) ? input.interval : 1000);
        state.busy = false;
      })();
      active.add(task); void task.finally(() => active.delete(task));
    }
    await delay(1);
  }
  await Promise.all(active);
  return probes;
}
process.on("message", (raw: unknown) => {
  const m = raw as { id: string; command: string; data: Input };
  if (m.command === "ping") { process.send?.({ id: m.id, data: performance.now() }); return; }
  if (m.command === "warm") {
    const data = m.data as unknown as { urls: string[] };
    void Promise.all(data.urls.map(async (url) => { const r = await fetch(`${url}/health`); await r.arrayBuffer(); })).then(() => process.send?.({ id: m.id, data: true }), (e: unknown) => process.send?.({ id: m.id, error: String(e) }));
    return;
  }
  if (m.command === "observe") {
    if (running) { process.send?.({ id: m.id, error: "Already observing" }); return; }
    running = true;
    void observe(m.data).then((data) => process.send?.({ id: m.id, data }), (error: unknown) => process.send?.({ id: m.id, error: String(error) })).finally(() => { running = false; });
  }
});
process.send?.({ id: "ready", data: true });
process.on("disconnect", () => process.exit(0));
