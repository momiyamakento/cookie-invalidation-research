/* global process, setImmediate */
import { PerformanceObserver, monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { channel } from 'node:diagnostics_channel';
import { getHeapStatistics, getHeapSpaceStatistics } from 'node:v8';

// Diagnostic-only preload. Never loaded by the ordinary application entry point.
export function createProbe() {
  let gc = [], requests = [], incoming = [];
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  const observer = new PerformanceObserver(list => {
    for (const e of list.getEntries()) gc.push({ start: performance.timeOrigin + e.startTime, duration: e.duration, ...e.detail });
  });
  observer.observe({ entryTypes: ['gc'] });
  let previous = performance.eventLoopUtilization();
  const snapshot = () => ({ at: performance.timeOrigin + performance.now(), memory: process.memoryUsage(), heap: getHeapStatistics(), spaces: getHeapSpaceStatistics(), cpu: process.cpuUsage(), resources: process.getActiveResourcesInfo() });
  return {
    snapshot,
    requests: () => requests,
    incoming: () => incoming,
    async read(reset = false) {
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      const current = performance.eventLoopUtilization();
      const result = { ...snapshot(), gc: [...gc], requests: [...requests], incoming: [...incoming], loop: { ...performance.eventLoopUtilization(current, previous), maxMs: histogram.max / 1e6, meanMs: Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : null } };
      if (reset) { gc = []; requests = []; incoming = []; histogram.reset(); previous = current; }
      return result;
    },
    close() { observer.disconnect(); histogram.disable(); },
  };
}

if (process.env.RESEARCH_DIAGNOSTIC_CHILD === '1') {
  const probe = createProbe();
  const clock = () => performance.timeOrigin + performance.now();
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const url = String(args[0]);
    if (!url.endsWith('/internal/v1/sessions/revoke')) return original(...args);
    const record = { start: clock(), headers: null, body: null, failed: false };
    probe.requests().push(record);
    try {
      const response = await original(...args);
      record.headers = clock();
      const json = response.json.bind(response);
      response.json = async () => { try { return await json(); } finally { record.body = clock(); } };
      return response;
    } catch (error) { record.failed = true; record.body = clock(); throw error; }
  };
  channel('http.server.request.start').subscribe(({ request, response }) => {
    if (request.url !== '/api/v1/detections') return;
    const record = { start: clock(), finish: null };
    probe.incoming().push(record);
    response.once('finish', () => { record.finish = clock(); });
  });
  process.on('message', async message => {
    if (!message || message.diagnostic !== true) return;
    try {
      if (message.command === 'gc') {
        if (!globalThis.gc) throw new Error('Start with --expose-gc');
        globalThis.gc();
      }
      const value = await probe.read(message.command === 'reset');
      process.send?.({ diagnostic: true, id: message.id, value });
    } catch (error) { process.send?.({ diagnostic: true, id: message.id, error: String(error) }); }
  });
  // The parent owns this diagnostic child; clean up even if the parent exits.
  process.once('disconnect', () => process.exit(0));
}
