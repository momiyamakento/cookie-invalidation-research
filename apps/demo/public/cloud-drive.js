/* global document, fetch, setTimeout */
(() => {
  const token = document.querySelector('meta[name="demo-token"]').content;
  const form = document.getElementById("drive-form");
  const error = document.getElementById("drive-error");
  let busy = false;
  async function request(path, options = {}) {
    const response = await fetch(`/demo/api/session/${path}`, { ...options, headers: { "Content-Type": "application/json", "X-Demo-Token": token } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "接続を確認してください。");
    return data;
  }
  async function refresh() {
    const data = await request("cloud-drive");
    const active = data.status === "logged-in";
    document.getElementById("drive-login").classList.toggle("hidden", active);
    document.getElementById("drive-content").classList.toggle("hidden", !active);
    document.getElementById("drive-status").textContent = active ? "ログイン中" : data.expired ? "ログイン状態が失効しました。Campus SNSでデモをリセットしてから再ログインしてください。" : data.status === "unknown" ? "接続を確認できません。再接続を待っています。" : "ユーザー名とパスワードでサインインしてください。";
    document.getElementById("drive-username").textContent = data.username ?? "";
    document.getElementById("drive-avatar").textContent = (data.username ?? "D").slice(0, 1).toUpperCase();
    document.getElementById("drive-files").replaceChildren(...data.files.map((name, index) => {
      const item = document.createElement("tr");
      const title = document.createElement("td");
      const badge = document.createElement("span"); badge.className = "file-badge"; badge.textContent = ["PDF", "CSV", "DOC"][index];
      title.append(badge, document.createTextNode(name)); item.append(title);
      for (const value of ["自分", ["今日 10:32", "昨日 16:45", "10月3日"][index], ["3.2 MB", "842 KB", "128 KB"][index], "☆"]) {
        const cell = document.createElement("td"); cell.textContent = value; item.append(cell);
      }
      return item;
    }));
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (busy) return;
    busy = true; form.querySelector("button").disabled = true; error.textContent = "";
    try {
      await request("login-site-b", { method: "POST", body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) });
      await refresh();
    } catch (failure) { error.textContent = failure.message; }
    finally { form.elements.password.value = ""; busy = false; form.querySelector("button").disabled = false; }
  });
  async function poll() {
    if (!busy) {
      try { await refresh(); }
      catch (failure) { error.textContent = failure.message; document.getElementById("drive-content").classList.add("hidden"); document.getElementById("drive-files").replaceChildren(); }
    }
    setTimeout(poll, 1500);
  }
  poll();
})();
