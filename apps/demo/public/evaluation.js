/* global document, fetch, setTimeout, URL */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const token = document.querySelector('meta[name="demo-token"]').content;
  let jobs = [], selectedId, submitting = false;
  const format = (value) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "—";
  const conditionText = (c) => `${c.loadProfile.toUpperCase()} / ${c.serviceCount} services / Delay ${c.serviceDelayMs} ms / Warm-up ${c.warmup} / Trials ${c.trials}`;
  async function api(path = "", options = {}) {
    const response = await fetch(`/demo/api/evaluations${path}`, { ...options, headers: { "X-Demo-Token": token, ...options.headers } });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response;
  }
  function error(message) { $("evaluation-error").textContent = message; $("evaluation-error").hidden = !message; }
  function svgNode(name, attributes, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function chart(job) {
    const svg = $("comparison-chart"); svg.replaceChildren();
    const c = job.condition;
    const matching = jobs.filter((j) => j.status === "completed" && j.condition.loadProfile === c.loadProfile &&
      j.condition.serviceDelayMs === c.serviceDelayMs && j.condition.warmup === c.warmup && j.condition.trials === c.trials &&
      j.summary.loadModelVersion === job.summary.loadModelVersion);
    const unique = new Map();
    matching.forEach((j) => { if (!unique.has(j.condition.serviceCount)) unique.set(j.condition.serviceCount, j); });
    const points = [...unique.values()].sort((a, b) => a.condition.serviceCount - b.condition.serviceCount);
    const maxY = Math.max(0.001, ...points.map((j) => j.summary.conditions[0].invalidationCompletionTimeMs.meanMs)) * 1.2;
    const maxX = Math.max(10, ...points.map((j) => j.condition.serviceCount));
    const x = (n) => 80 + n / maxX * 700, y = (n) => 205 - n / maxY * 155;
    svg.append(svgNode("text", { x: 20, y: 22 }, "全体失効時間 平均 (ms)"));
    svg.append(svgNode("text", { x: 370, y: 250 }, "サービス数 (services)"));
    for (let i = 0; i <= 4; i++) {
      const value = maxY * i / 4;
      svg.append(svgNode("line", { x1: 80, y1: y(value), x2: 780, y2: y(value), stroke: "#e0e7ef" }));
      svg.append(svgNode("text", { x: 72, y: y(value) + 4, "text-anchor": "end" }, value.toFixed(2)));
    }
    if (points.length > 1) svg.append(svgNode("polyline", { points: points.map((j) => `${x(j.condition.serviceCount)},${y(j.summary.conditions[0].invalidationCompletionTimeMs.meanMs)}`).join(" "), fill: "none", stroke: "#245b9f", "stroke-width": 2 }));
    points.forEach((j) => {
      const count = j.condition.serviceCount, value = j.summary.conditions[0].invalidationCompletionTimeMs.meanMs;
      const point = svgNode("circle", { cx: x(count), cy: y(value), r: 5, fill: "#245b9f" });
      point.append(svgNode("title", {}, `${count} services: ${format(value)} ms`)); svg.append(point);
      svg.append(svgNode("text", { x: x(count), y: 225, "text-anchor": "middle" }, count));
    });
    svg.removeAttribute("hidden");
    $("chart-label").textContent = `${c.loadProfile.toUpperCase()} · Delay ${c.serviceDelayMs} ms · Warm-up ${c.warmup} · Trials ${c.trials}`;
    $("chart-empty").textContent = points.length === 1 ? "現在は1サービス数の結果です。サービス数を変えて実行すると比較できます。" : `${points.length}種類のサービス数を比較しています。線は各平均値を結んだものです。`;
  }
  function showResult(job) {
    $("evaluation-result").hidden = job?.status !== "completed";
    if (job?.status !== "completed") return;
    const stats = job.summary.conditions[0];
    $("result-condition").textContent = conditionText(job.condition);
    $("actual-value").textContent = `${format(stats.actualProcessingMs.meanMs)} ms`;
    $("delay-value").textContent = `${format(stats.measuredDelayMs.meanMs)} ms`;
    $("overall-value").textContent = `${format(stats.invalidationCompletionTimeMs.meanMs)} ms`;
    $("success-count").textContent = `成功 ${job.successes} / 失敗 ${job.failures} サービス要求（${job.condition.serviceCount}サービス × ${job.condition.trials}測定試行）`;
    $("statistics").replaceChildren();
    for (const [key, label] of [["invalidationCompletionTimeMs", "全体失効時間"], ["actualProcessingMs", "実処理 actualProcessingMs"], ["measuredDelayMs", "待機 measuredDelayMs"], ["serviceProcessingMs", "サービス内合計 serviceProcessingMs"]]) {
      const row = document.createElement("tr");
      const title = document.createElement("th"); title.scope = "row"; title.textContent = label; row.append(title);
      for (const metric of ["meanMs", "medianMs", "minMs", "maxMs", "populationStandardDeviationMs"]) {
        const cell = document.createElement("td"); cell.textContent = format(stats[key][metric]); row.append(cell);
      }
      $("statistics").append(row);
    }
    chart(job);
  }
  function render() {
    const running = jobs.find((j) => j.status === "running");
    $("condition-fields").disabled = submitting || Boolean(running);
    const badge = $("evaluation-status");
    const latest = jobs[0];
    badge.textContent = running ? "評価実行中" : latest?.status === "completed" ? "評価完了" : latest?.status === "failed" ? "評価失敗" : "待機中";
    badge.className = `badge ${running ? "busy" : latest?.status === "completed" ? "good" : latest?.status === "failed" ? "alert" : "neutral"}`;
    $("run-message").textContent = running ? `${conditionText(running.condition)} — 実行中。試行単位の進捗は完了後に表示します。` : latest ? `前回の評価：${conditionText(latest.condition)}` : "条件を選択して評価を開始してください。";
    if (latest?.status === "failed") error(latest.error);
    $("history").replaceChildren();
    jobs.forEach((job) => {
      const item = document.createElement("div"); item.className = "history-item";
      const text = document.createElement("p");
      text.textContent = `${conditionText(job.condition)} / ${new Date(job.startedAt).toLocaleString("ja-JP")} / ${{running:"実行中",completed:"完了",failed:"失敗"}[job.status]}`;
      item.append(text);
      if (job.status === "completed") {
        const button = document.createElement("button"); button.className = "button secondary"; button.textContent = "結果を表示";
        button.addEventListener("click", () => { selectedId = job.id; showResult(job); }); item.append(button);
      }
      $("history").append(item);
    });
    if (!selectedId) selectedId = latest?.id;
    showResult(jobs.find((j) => j.id === selectedId));
  }
  async function refresh() { jobs = await (await api()).json(); render(); }
  $("evaluation-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (submitting || jobs.some((j) => j.status === "running")) return;
    submitting = true; error(""); $("condition-fields").disabled = true;
    try {
      const condition = { serviceCount: Number($("service-count").value), loadProfile: $("load-profile").value,
        serviceDelayMs: Number($("service-delay").value), warmup: Number($("warmup").value), trials: Number($("trials").value) };
      const job = await (await api("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(condition) })).json();
      selectedId = job.id; await refresh();
    } catch (e) { error(e.message); }
    finally { submitting = false; render(); }
  });
  document.querySelectorAll("[data-file]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const response = await api(`/${selectedId}/files/${button.dataset.file}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = button.dataset.file;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { error(e.message); }
  }));
  async function poll() {
    try { await refresh(); }
    catch (e) { error(`状態を取得できません。${e.message}`); $("condition-fields").disabled = true; }
    setTimeout(poll, 1500);
  }
  void poll();
})();
