const KEYS = { enabled: true, autoFill: true, autoAdvance: false, autoSubmit: false, useClaude: true };
// Hunt settings without Settings defaults. Settings > Job hunt (config.json
// "hunt") gives roles, locations and skip words when the popup has none saved.
const HUNT_DEFAULTS = {
  roles: "Software Engineer",
  locations: "Remote",
  exclude: "Senior, Sr., Sr, Staff, Principal, Lead, Manager, Director, Head of, Intern, III, IV, Architect",
  freshness: "m", pages: 3, maxJobs: 50, perCompany: 3, parallel: 2, huntSubmit: false, ownWindow: false, keepReview: false,
  siteAshby: true, siteGreenhouse: true, siteLever: true,
};
const $ = (id) => document.getElementById(id);
const status = $("status");

chrome.storage.local.get(KEYS).then((s) => {
  for (const k of Object.keys(KEYS)) {
    const box = $(k);
    box.checked = s[k];
    box.onchange = () => chrome.storage.local.set({ [k]: box.checked });
  }
});

// Defaults from Settings: roles, locations, skip words.
function settingsDefaults(setup) {
  const h = (setup && setup.hunt) || {};
  const sec = (setup && setup.config) || {};
  const country = (sec.location && sec.location.country) || "";
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
  const out = {};
  if (list(h.roles).length) out.roles = list(h.roles).join("\n");
  out.locations = list(h.locations).length ? list(h.locations).join(", ") : [country, "Remote"].filter(Boolean).join(", ");
  if (list(h.exclude_titles).length) out.exclude = list(h.exclude_titles).join(", ");
  return out;
}

function showCfg(cfg) {
  for (const k of Object.keys(HUNT_DEFAULTS)) {
    const el = $(k);
    if (el.type === "checkbox") el.checked = cfg[k]; else el.value = cfg[k];
    el.onchange = saveCfg;
  }
}

let setupInfo = null;
(async () => {
  setupInfo = await chrome.runtime.sendMessage({ type: "setup" });
  const { huntCfg } = await chrome.storage.local.get("huntCfg");
  showCfg({ ...HUNT_DEFAULTS, ...(huntCfg || settingsDefaults(setupInfo)) });
  const warn = [];
  if (setupInfo.configError) warn.push(setupInfo.configError);
  if (setupInfo.missing.length) warn.push("Profile incomplete: " + setupInfo.missing.join(", ") + ".");
  if (!setupInfo.resume) warn.push("extension/resume.pdf is missing.");
  if (warn.length) {
    $("setup").style.display = "block";
    $("setup").textContent = warn.join(" ") + " ";
    const a = document.createElement("a");
    a.textContent = "Open Settings";
    a.onclick = () => chrome.runtime.openOptionsPage();
    $("setup").appendChild(a);
  }
})();

$("settings").onclick = () => chrome.runtime.openOptionsPage();
$("huntDefaults").onclick = () => {
  showCfg({ ...readCfg(), ...settingsDefaults(setupInfo) });
  saveCfg();
};

function readCfg() {
  const out = {};
  for (const k of Object.keys(HUNT_DEFAULTS)) {
    const el = $(k);
    out[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  }
  return out;
}
const saveCfg = () => chrome.storage.local.set({ huntCfg: readCfg() });

const list = (s) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const clamp = (n, lo, hi, d) => (Number.isFinite(n) && n >= lo ? Math.min(n, hi) : d);

$("start").onclick = async () => {
  saveCfg();
  const c = readCfg();
  const cfg = {
    roles: list(c.roles).slice(0, 10),
    locations: list(c.locations).slice(0, 8),
    exclude: list(c.exclude),
    freshness: c.freshness,
    pages: clamp(c.pages, 1, 10, 3),
    maxJobs: clamp(c.maxJobs, 1, 300, 100),
    perCompany: clamp(c.perCompany, 1, 20, 3),
    keepReview: c.keepReview,
    sites: [c.siteAshby && "ashby", c.siteGreenhouse && "greenhouse", c.siteLever && "lever"].filter(Boolean),
    parallel: clamp(c.parallel, 1, 4, 2),
    submit: c.huntSubmit,
    ownWindow: c.ownWindow,
  };
  // Chrome can withhold site access. Ask for it here: a request needs a click.
  const need = { origins: ["https://www.google.com/*", "https://jobs.ashbyhq.com/*", "https://job-boards.greenhouse.io/*", "https://jobs.lever.co/*"] };
  try {
    if (!(await chrome.permissions.contains(need))) await chrome.permissions.request(need);
  } catch (e) {}
  const r = await chrome.runtime.sendMessage({ type: "huntStart", cfg });
  if (r && r.error) { startError = r.error; }
  else startError = "";
  refresh();
};
$("stop").onclick = () => chrome.runtime.sendMessage({ type: "huntStop" }).then(refresh);
$("copyDbg").onclick = (e) => {
  e.preventDefault();
  navigator.clipboard.writeText($("dbg").textContent);
  $("copyDbg").textContent = "copied";
};

$("csv").onclick = async () => {
  const { huntLog = [] } = await chrome.storage.local.get("huntLog");
  // A leading = + - @ makes Excel run the cell as a formula. A quote stops that.
  const q = (v) => `"${String(v ?? "").replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
  const rows = [["time", "status", "company", "title", "url", "detail"],
    ...huntLog.map((e) => [e.time, e.status, e.company, e.title, e.url, e.detail])];
  const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `edith-hunt-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

$("reset").onclick = async () => {
  if (!confirm("Clear the hunt history? Jobs seen before can open again.")) return;
  await chrome.runtime.sendMessage({ type: "huntReset" });
  refresh();
};

// Status groups shown as tiles.
const GROUPS = {
  submitted: ["submitted"],
  review: ["needs_review", "filled", "submit_failed", "timeout"],
  skipped: ["closed", "no_form", "tab_closed", "stopped", "skipped_location", "rate_limited"],
  errors: ["error"],
};
const sum = (counts, keys) => keys.reduce((n, k) => n + (counts[k] || 0), 0);

function tiles(el, list) {
  el.innerHTML = list.map(([n, label, tone]) =>
    `<div class="tile ${tone}"><b>${n}</b><span>${label}</span></div>`).join("");
}

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

let startError = "";
async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "huntStatus" });
  if (s && !s.error) {
    $("start").disabled = s.running;
    $("hstatus").className = s.phase === "captcha" || startError ? "bad" : "";
    $("hstatus").textContent = startError || s.message || "Idle.";
    const c = s.counts || {};
    tiles($("runStats"), [
      [s.found, "found", "info"],
      [c.excluded || 0, "skipped title", ""],
      [s.queued, "queued", ""],
      [s.active, "applying now", "info"],
      [c.submitted || 0, "submitted", "ok"],
      [sum(c, GROUPS.review), "need review", "warn"],
      [sum(c, GROUPS.skipped), "closed/skip", ""],
      [sum(c, GROUPS.errors), "errors", "err"],
    ]);
    const dbgText = (s.debug || []).join("\n") || "(empty — start a hunt)";
    if ($("dbg").textContent !== dbgText) {
      const pre = $("dbg");
      const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 5;
      pre.textContent = dbgText;
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    }
    $("elapsed").textContent = s.startedAt ? `· ${fmtTime((s.endedAt || Date.now()) - s.startedAt)}` : "";
    $("current").innerHTML = "";
    for (const line of s.current || []) {
      const d = document.createElement("div");
      d.textContent = "▶ " + line;
      $("current").appendChild(d);
    }
  }
  const { huntLog = [] } = await chrome.storage.local.get("huntLog");
  const all = {};
  for (const e of huntLog) all[e.status] = (all[e.status] || 0) + 1;
  tiles($("allStats"), [
    [huntLog.length, "jobs opened", "info"],
    [all.submitted || 0, "submitted", "ok"],
    [sum(all, GROUPS.review), "need review", "warn"],
    [sum(all, GROUPS.errors), "errors", "err"],
  ]);
  $("log").innerHTML = "";
  for (const e of huntLog.slice(0, 30)) {
    const d = document.createElement("div");
    d.className = "s-" + e.status;
    d.title = `${e.url}\n${e.detail || ""}`;
    d.textContent = `${e.status} · ${e.company} · ${e.title || ""}`;
    d.style.cursor = "pointer";
    d.onclick = () => chrome.tabs.create({ url: e.url });
    $("log").appendChild(d);
  }
}
refresh();
setInterval(refresh, 1000);

chrome.storage.local.get({ useClaude: true }).then(({ useClaude }) => {
  if (!useClaude) { status.textContent = "Claude: off. Built-in answers only."; return; }
  fetch("http://127.0.0.1:8765/health")
    .then(() => (status.textContent = "Claude: on. Helper is running."))
    .catch(() => {
      status.textContent = "Claude: helper not running, so unknown questions stay empty. Start it: python3 helper/server.py";
      status.title = "Optional. Built-in answers work without it.";
      status.className = "bad";
    });
});

$("open").onclick = () => {
  const urls = $("links").value.split(/\s+/).filter((u) => /^https?:\/\//.test(u));
  chrome.runtime.sendMessage({ type: "openLinks", urls }, () => (status.textContent = `Opened ${urls.length} tabs`));
};

$("fill").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "fillActive" });
  if (r && r.error) { status.textContent = r.error; status.className = "bad"; return; }
  window.close();
};
