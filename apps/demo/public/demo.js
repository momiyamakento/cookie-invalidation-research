/* global document, fetch, navigator, setTimeout, window */
(() => {
  "use strict";
  const token = document.querySelector('meta[name="demo-token"]')?.content ?? "";
  const screen = document.body.dataset.screen;
  const names = { "site-a": "Campus SNS", "site-b": "Cloud Drive", "site-c": "Online Store", "site-d": "Student Portal" };
  let state = null;
  let polling = false;
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const request = async (path, options = {}) => {
    const response = await fetch(`/demo/api/${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", "X-Demo-Token": token, ...(options.headers || {}) },
    });
    let data;
    try { data = await response.json(); } catch { data = { error: "応答を読み取れませんでした。" }; }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  };
  const toast = (message) => {
    const node = $("toast"); if (!node) return;
    node.textContent = message; node.classList.add("visible");
    window.setTimeout(() => node.classList.remove("visible"), 1500);
  };
  const abbreviated = (value) => value.length > 28 ? `${value.slice(0, 15)}…${value.slice(-9)}` : value;
  const cookieRow = (name, value, purpose = "") => `<div class="cookie-row"><div class="cookie-row-head"><span class="cookie-name">${escapeHtml(name)}</span><button type="button" class="copy-button" data-copy="${escapeHtml(value)}">コピー</button></div>${purpose ? `<span class="cookie-purpose ${purpose === "検知用の囮Cookie" ? "decoy" : "regular"}">${purpose}</span>` : ""}<code class="cookie-value" title="${escapeHtml(value)}">${escapeHtml(abbreviated(value))}</code></div>`;
  const bindCopy = (root = document) => root.querySelectorAll("[data-copy]").forEach((button) => {
    button.onclick = async () => {
      try { await navigator.clipboard.writeText(button.dataset.copy || ""); toast("コピーしました"); }
      catch { toast("コピーできません。ブラウザの設定を確認してください。"); }
    };
  });
  const serviceList = (services) => services.map((service) => {
    const label = service.status === "logged-in" ? "ログイン中" : service.status === "revoked" ? "セッション失効" : service.status === "signed-out" ? "未ログイン" : "確認中";
    return `<li><span>${names[service.id] || service.id}</span><span class="status ${service.status}">${label}</span></li>`;
  }).join("");
  const feed = (items) => items.map((item, index) => `<article class="feed-item"><div class="feed-author"><span class="feed-avatar">${escapeHtml(item.author.slice(0, 1).toUpperCase())}</span><strong>${escapeHtml(item.author)}</strong><span class="feed-more">•••</span></div><div class="feed-photo photo-${index % 3}" aria-hidden="true"><span>${index === 0 ? "CAMPUS" : index === 1 ? "LAB NOTES" : "STUDENT LIFE"}</span></div><p>${escapeHtml(item.text)}</p><div class="feed-actions" aria-hidden="true">♡ ◯ ⌁ <span>♡ 12件</span></div></article>`).join("");
  const messages = (items) => items.map((item) => `<article class="message"><strong>${escapeHtml(item.from)}</strong><p>${escapeHtml(item.text)}</p></article>`).join("");
  const drafts = (items) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  const renderVictim = (next) => {
    state = next;
    const loggedIn = Boolean(next.profile);
    const revoked = next.services.some((service) => service.status === "revoked");
    const sessionExpired = revoked || (loggedIn && next.services.some((service) => service.id === "site-a" && service.status === "signed-out"));
    const showHome = loggedIn && !sessionExpired;
    $("login-view")?.classList.toggle("hidden", showHome);
    $("sns-view")?.classList.toggle("hidden", !showHome);
    $("cookie-open")?.classList.toggle("hidden", !next.cookies || sessionExpired);
    $("expired-login-notice")?.classList.toggle("hidden", !sessionExpired);
    document.body.classList.toggle("session-revoked", sessionExpired);
    if (sessionExpired) {
      $("message-items").replaceChildren(); $("draft-items").replaceChildren();
      $("timeline-items").replaceChildren(); $("saved-item").textContent = "";
      $("cookie-dialog").close(); $("service-dialog").close();
      return;
    }
    if (!loggedIn) return;
    const profile = next.profile;
    $("profile").innerHTML = `<div class="avatar">${escapeHtml(profile.username.slice(0, 1).toUpperCase())}</div><div><h1>${escapeHtml(profile.username)}</h1><p>${escapeHtml(profile.handle)} · ${escapeHtml(profile.email)}</p></div><p class="bio">${escapeHtml(profile.bio)}</p>`;
    $("timeline-items").innerHTML = feed(profile.timeline);
    $("message-items").innerHTML = messages(profile.messages);
    $("draft-items").innerHTML = drafts(profile.drafts);
    $("saved-item").textContent = profile.saved;
    $("victim-services").innerHTML = serviceList(next.services);
    const otherReady = next.services.filter((service) => ["site-c", "site-d"].includes(service.id)).every((service) => service.status === "logged-in");
    $("login-others").disabled = otherReady || next.services[0]?.status !== "logged-in";
    $("login-others").textContent = otherReady ? "Store・Portalにログイン済み" : "Store・Portalにログイン";
    $("service-open").disabled = !next.services.every((service) => service.status === "logged-in");
    $("revoked-banner").classList.toggle("hidden", !revoked);
    if (next.cookies) {
      $("victim-cookie-list").innerHTML = cookieRow("session_id", next.cookies.sid_site_a, "通常セッションCookie") + cookieRow("session_state", next.cookies.decoy_site_a, "検知用の囮Cookie");
      bindCopy($("victim-cookie-list"));
    }
  };

  const setProcess = (key, status) => {
    const row = document.querySelector(`[data-key="${key}"]`); if (!row) return;
    row.classList.toggle("processing", status === "処理中"); row.classList.toggle("complete", status === "完了");
    row.querySelector("b").textContent = status;
  };
  const renderCompromised = (profile) => {
    const view = $("compromised-view"); view.classList.remove("hidden");
    $("compromised-avatar").textContent = profile.username.slice(0, 1).toUpperCase();
    $("compromised-name").textContent = profile.username;
    $("compromised-meta").textContent = `${profile.handle} · ${profile.email}`;
    $("compromised-bio").textContent = profile.bio;
    $("compromised-messages").innerHTML = messages(profile.messages);
    $("compromised-drafts").innerHTML = drafts(profile.drafts);
    $("compromised-timeline").innerHTML = feed(profile.timeline);
    $("compromised-saved").textContent = profile.saved;
  };
  const renderAttacker = (next) => {
    const hadStolenCookies = Boolean(state?.stolenCookies);
    state = next;
    const stolen = next.stolenCookies;
    $("stolen-empty").classList.toggle("hidden", Boolean(stolen));
    $("stolen-cookie-list").classList.toggle("hidden", !stolen);
    if (stolen) {
      $("stolen-cookie-list").innerHTML = cookieRow("session_id", stolen.sid_site_a, "通常セッションCookie") + cookieRow("session_state", stolen.decoy_site_a, "検知用の囮Cookie");
      bindCopy($("stolen-cookie-list"));
      $("steal-cookie").disabled = true; $("steal-cookie").textContent = "Cookie取得済み";
    } else {
      $("stolen-cookie-list").innerHTML = "";
      $("steal-cookie").disabled = false; $("steal-cookie").textContent = "Cookieを窃取";
      if (hadStolenCookies) {
        $("cookie-input").value = ""; $("access-result").className = "access-result hidden";
        $("compromised-view").classList.add("hidden");
      }
    }
    $("attacker-services").innerHTML = serviceList(next.services);
    const revocation = next.revocation;
    $("detection-panel").classList.toggle("hidden", !revocation.attempted);
    document.body.classList.toggle("has-intrusion", next.attacker.status === "success" && Boolean(next.profile));
    if (!revocation.attempted) ["decoy", "notify", "identify", "services", "request", "complete"].forEach((key) => setProcess(key, "待機"));
    if (revocation.attempted) setProcess("decoy", "完了");
    if (revocation.notification === "notified") setProcess("notify", "完了");
    if (revocation.principalId) setProcess("identify", "完了");
    if (revocation.targets.length) setProcess("services", "完了");
    if (revocation.targets.some((target) => target.status !== "PENDING")) setProcess("request", "完了");
    if (revocation.complete) setProcess("complete", "完了");
    if (next.attacker.status === "success" && next.profile) renderCompromised(next.profile);
    if (next.attacker.status === "revoked" || (revocation.complete && next.attacker.status === "denied")) $("compromised-view").classList.add("hidden");
    $("direct-session-link").classList.toggle("hidden", next.attacker.status !== "success");
  };
  const refresh = async () => {
    if (polling) return; polling = true;
    try {
      const next = await request("session");
      if (screen === "victim") renderVictim(next); else renderAttacker(next);
      if ($("connection-status")) $("connection-status").textContent = "接続済み";
    } catch {
      if ($("connection-status")) $("connection-status").textContent = "接続を確認してください";
    } finally { polling = false; }
  };

  if (screen === "victim") {
    $("login-form").addEventListener("submit", async (event) => {
      event.preventDefault(); $("login-error").textContent = "";
      const button = event.currentTarget.querySelector("button"); button.disabled = true;
      try {
        const next = await request("session/login-site-a", { method: "POST", body: JSON.stringify({ username: $("username").value, password: $("password").value }) });
        $("password").value = ""; renderVictim(next);
      } catch (error) { $("login-error").textContent = error.message; }
      finally { button.disabled = false; }
    });
    $("login-others").addEventListener("click", async () => {
      const button = $("login-others"); button.disabled = true;
      try { renderVictim(await request("session/login-automatic", { method: "POST", body: "{}" })); }
      catch (error) { toast(error.message); button.disabled = false; }
    });
    $("cookie-open").addEventListener("click", () => $("cookie-dialog").showModal());
    $("service-open").addEventListener("click", () => $("service-dialog").showModal());
    $("reset-demo").addEventListener("click", async () => {
      const button = $("reset-demo"); button.disabled = true;
      try { renderVictim(await request("session/reset", { method: "POST", body: "{}" })); window.location.reload(); }
      catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });
  } else {
    $("steal-cookie").addEventListener("click", async () => {
      $("steal-error").textContent = ""; const button = $("steal-cookie"); button.disabled = true;
      $("transfer-flow").classList.add("running");
      try { await wait(1200); renderAttacker(await request("attacker/steal", { method: "POST", body: "{}" })); }
      catch (error) { $("steal-error").textContent = error.message; button.disabled = false; }
      finally { $("transfer-flow").classList.remove("running"); }
    });
    $("cookie-access-form").addEventListener("submit", async (event) => {
      event.preventDefault(); $("access-error").textContent = "";
      const value = $("cookie-input").value.trim(); const button = event.currentTarget.querySelector("button"); button.disabled = true;
      const isKnownDecoy = Boolean(state?.stolenCookies && value === state.stolenCookies.decoy_site_a);
      if (isKnownDecoy) setProcess("decoy", "処理中");
      try {
        const next = await request("attacker/use-cookie", { method: "POST", body: JSON.stringify({ cookie: value }) });
        const result = $("access-result"); result.className = "access-result";
        if (next.revocation?.attempted) {
          result.classList.add("alert"); result.innerHTML = "<h3>異常なCookie利用を検知</h3><p>使用されたCookieは囮Cookieでした。</p>";
          renderAttacker(next);
        } else if (next.attacker?.status === "success") {
          result.innerHTML = "<h3>アクセス成功</h3><p>パスワードを使わず、Campus SNSの本人用画面を取得しました。</p>";
          await refresh();
        } else if (next.attacker?.status === "denied" || next.attacker?.status === "revoked") {
          result.classList.add("error"); result.innerHTML = state?.revocation?.complete
            ? "<h3>アクセスできません</h3><p><strong>Session Expired</strong></p><p>このセッションは既に失効しています。</p>"
            : "<h3>アクセスできません</h3><p>このCookieは有効なセッションと一致しません。</p>";
          await refresh();
        } else {
          result.classList.add("error"); result.innerHTML = "<h3>アクセスできません</h3><p>Cookieの形式または接続状態を確認してください。</p>";
        }
        result.classList.remove("hidden");
      } catch (error) { $("access-error").textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  void refresh();
  window.setInterval(() => void refresh(), 1200);
})();
