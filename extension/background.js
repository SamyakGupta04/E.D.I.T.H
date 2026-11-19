// EDITH background: loads your profile, relays content-script requests to the
// local helper (Claude), keeps the job description of each tab, and runs the
// job hunt (Google search -> company job lists -> apply).
importScripts("shared.js");
const HELPER = "http://127.0.0.1:8765";

async function helper(path, body) {
  let res;
  try {
    res = await fetch(HELPER + path, body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("helper not running. Start it: python3 helper/server.py");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ======================= config and resume =======================
// Your data lives in chrome.storage ("config"). Two ways to change it:
//   1. Settings page (options.html): saves to chrome.storage at once.
//   2. extension/config.json: read when the extension starts. A changed file
//      replaces the stored config. Reload the extension after an edit.
let configCache = null;
let configError = "";

// djb2 hash: tells whether config.json changed since the last import.
const hashText = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(16); };

async function readBundled(name) {
  try {
    const r = await fetch(chrome.runtime.getURL(name));
    return r.ok ? r : null;
  } catch (e) {
    return null; // the file is not in the extension folder
  }
}

async function importConfigFile(force) {
  const r = await readBundled("config.json");
  if (!r) return { ok: false, error: "extension/config.json not found" };
  const text = await r.text();
  const hash = hashText(text);
  const { configHash } = await chrome.storage.local.get("configHash");
  if (!force && configHash === hash) return { ok: true, changed: false };
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    configError = "config.json is not valid JSON: " + e.message;
    return { ok: false, error: configError };
  }
  configError = "";
  await chrome.storage.local.set({ config: cfg, configHash: hash });
  configCache = null;
  console.log("[edith] config.json imported");
  return { ok: true, changed: true };
}
const configReady = importConfigFile(false).catch((e) => { configError = String(e.message || e); });

async function getConfig() {
  await configReady;
  if (!configCache) {
    const { config = {} } = await chrome.storage.local.get("config");
    const profile = EdithShared.toProfile(config);
    configCache = { config, profile, hunt: config.hunt || {}, places: EdithShared.places(profile) };
  }
  return configCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config) configCache = null;
});

const loadProfile = async () => (await getConfig()).profile;

// The profile that goes to Claude: no hunt settings and no writing templates.
async function claudeProfile() {
  const p = { ...(await loadProfile()) };
  const instructions = p.claude_instructions || "";
  delete p.claude_instructions;
  delete p.cover_letter_template;
  return { profile: p, instructions };
}

// Three resumes, chosen by the job title (shared.js: jobTrack):
//   resume.pdf      default, software roles
//   resume_ai.pdf   AI and ML roles (optional)
//   resume_apm.pdf  product management roles (optional)
const TRACK_RESUME = { pm: "resume_apm.pdf", ai: "resume_ai.pdf", sde: "resume.pdf" };
const resumeByTab = new Map(); // tabId -> { file, track }, for the Claude helper
chrome.tabs.onRemoved.addListener((id) => resumeByTab.delete(id));

async function trackFor(tabId, pageTitle) {
  const t = hunt.tabs.get(tabId);
  const saved = t ? null : await getJob(tabId);
  const title = (t && t.job.title) || (saved && saved.title) || pageTitle || "";
  const track = EdithShared.jobTrack(title);
  const file = (await readBundled(TRACK_RESUME[track])) ? TRACK_RESUME[track] : "resume.pdf";
  const old = resumeByTab.get(tabId);
  resumeByTab.set(tabId, { file, track });
  if (t && !(old && old.file === file)) dbg(`  ${t.job.company}: ${track} job, resume ${file} ("${title.slice(0, 50)}")`);
  return { file, track };
}
const resumeFileFor = async (tabId, pageTitle) => (await trackFor(tabId, pageTitle)).file;

// The site gets the file as "First_Last_Resume.pdf".
async function loadResume(tabId, pageTitle) {
  const p = await loadProfile();
  const r = await readBundled(await resumeFileFor(tabId, pageTitle));
  if (!r) return { error: "extension/resume.pdf not found. Put your resume there and reload the extension." };
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const base = (p.full_name || "").trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
  return { b64: btoa(bin), name: base ? base + "_Resume.pdf" : "resume.pdf" };
}

// What the popup and the Settings page show about the setup.
async function setupStatus() {
  const { config, profile, hunt } = await getConfig();
  const resume = !!(await readBundled("resume.pdf"));
  const resumeAi = !!(await readBundled("resume_ai.pdf"));
  const resumePm = !!(await readBundled("resume_apm.pdf"));
  const configFile = !!(await readBundled("config.json"));
  return { config, hunt, missing: EdithShared.missingRequired(profile), resume, resumeAi, resumePm, configFile, configError,
    name: profile.full_name || "" };
}

async function getJob(tabId) {
  const key = "job" + tabId;
  const got = await chrome.storage.session.get(key);
  if (got[key]) return got[key];
  try {
    // A tab opened from the job page ("Apply" in a new tab) uses the opener's job.
    const tab = await chrome.tabs.get(tabId);
    if (tab.openerTabId) {
      const k2 = "job" + tab.openerTabId;
      const g2 = await chrome.storage.session.get(k2);
      if (g2[k2]) return g2[k2];
    }
  } catch (e) {}
  return null;
}

// ======================= master ON/OFF =======================
async function isEnabled() {
  return (await chrome.storage.local.get({ enabled: true })).enabled;
}

async function showEnabled() {
  const on = await isEnabled();
  chrome.action.setBadgeText({ text: on ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#16a34a" : "#6b7280" });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  showEnabled();
  if (!changes.enabled.newValue) stopHunt("extension switched off");
});
chrome.runtime.onStartup.addListener(showEnabled);
chrome.runtime.onInstalled.addListener(async (d) => {
  showEnabled();
  // First install with no profile: open Settings.
  if (d.reason === "install") {
    const { profile } = await getConfig();
    if (EdithShared.missingRequired(profile).length) chrome.runtime.openOptionsPage();
  }
});

// ======================= one-time data reset =======================
// History written before DATA_VERSION is cleared once: the job log, the list
// of jobs already seen, and the debug log. Settings stay. Later reloads keep
// the history, because the stored version then matches.
const DATA_VERSION = 2;
const dataReady = (async () => {
  const { dataVersion } = await chrome.storage.local.get("dataVersion");
  if (dataVersion === DATA_VERSION) return;
  await chrome.storage.local.set({ huntLog: [], huntSeen: {}, huntDebug: [], dataVersion: DATA_VERSION });
  console.log("[edith] hunt history cleared (data version " + DATA_VERSION + ")");
})();

// ======================= job hunt =======================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JOB_TIMEOUT_MS = 240000;   // one application tab, all steps
const PAGE_TIMEOUT_MS = 30000;   // one Google results page load
const CAPTCHA_WAIT_MS = 180000;  // time for the user to solve a Google CAPTCHA
const MAX_REVIEW_TABS = 10;      // with "keep review tabs open": tabs left open, then the hunt stops
const JOB_GAP_MS = 10000;        // minimum time between two job starts (job-site rate limit)
const MAX_ATTEMPTS = 3;          // tries for one job that met the rate limit
const ASHBY_JOB = /^https?:\/\/jobs\.ashbyhq\.com\/([^\/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const SITE_ACCESS = { origins: ["https://www.google.com/*", "https://jobs.ashbyhq.com/*", "https://job-boards.greenhouse.io/*", "https://jobs.lever.co/*"] };
// Extra access for a site that is switched on in the hunt.
const SITE_ORIGINS = { keka: ["https://*.keka.com/*"] };
const NO_ACCESS_MSG = "Chrome blocks this extension on Google and the job sites. Open chrome://extensions > EDITH > Details > Site access, and select 'On all sites'. Then start again.";

// ---------- job sites ----------
// Each site has: how to read a job link, the public job list of one company,
// the address of the application form, and the "seed" companies from
// Settings > Job hunt (config.json: hunt.seed_ashby, seed_greenhouse, seed_lever).
const PROVIDERS = {
  ashby: {
    label: "Ashby",
    sites: ["jobs.ashbyhq.com"],
    job: (href) => { const m = href.match(ASHBY_JOB); return m ? { org: decodeURIComponent(m[1]), id: m[2].toLowerCase() } : null; },
    org: (href) => { const m = href.match(/^https?:\/\/jobs\.ashbyhq\.com\/([^\/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; },
    listUrl: (org) => "https://api.ashbyhq.com/posting-api/job-board/" + encodeURIComponent(org),
    jobs: (d) => (d.jobs || []).map((j) => {
      const places = [j, ...(j.secondaryLocations || [])];
      return { id: String(j.id).toLowerCase(), title: j.title, listed: j.isListed !== false,
        loc: places.map((p) => p.location).filter(Boolean).join("; "),
        country: places.map((p) => p.address && p.address.postalAddress && p.address.postalAddress.addressCountry).filter(Boolean).join("; ") };
    }),
    applyUrl: (org, id) => `https://jobs.ashbyhq.com/${encodeURIComponent(org)}/${id}/application`,
    key: (org, id) => (org + "/" + id).toLowerCase(), // no prefix: the same keys as the older versions
    seedKey: "seed_ashby",
  },
  greenhouse: {
    label: "Greenhouse",
    sites: ["job-boards.greenhouse.io", "boards.greenhouse.io"],
    job: (href) => {
      let m = href.match(/^https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/(?!embed\b)([^\/?#]+)\/jobs\/(\d+)/i);
      if (!m) m = href.match(/greenhouse\.io\/embed\/job_app\?(?:[^#]*&)?for=([^&#]+)[^#]*[?&]token=(\d+)/i);
      return m ? { org: decodeURIComponent(m[1]).toLowerCase(), id: m[2] } : null;
    },
    org: (href) => { const m = href.match(/^https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/(?!embed\b)([^\/?#]+)/i); return m ? decodeURIComponent(m[1]).toLowerCase() : null; },
    listUrl: (org) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(org)}/jobs`,
    jobs: (d) => (d.jobs || []).map((j) => ({ id: String(j.id), title: j.title, listed: true, loc: (j.location && j.location.name) || "", country: "" })),
    // The direct form address. It works also for companies that show the job on their own site.
    applyUrl: (org, id) => `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(org)}&token=${id}`,
    key: (org, id) => `greenhouse:${org}/${id}`.toLowerCase(),
    seedKey: "seed_greenhouse",
  },
  lever: {
    label: "Lever",
    sites: ["jobs.lever.co"],
    job: (href) => { const m = href.match(/^https?:\/\/jobs\.lever\.co\/([^\/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i); return m ? { org: decodeURIComponent(m[1]).toLowerCase(), id: m[2].toLowerCase() } : null; },
    org: (href) => { const m = href.match(/^https?:\/\/jobs\.lever\.co\/([^\/?#]+)/i); return m ? decodeURIComponent(m[1]).toLowerCase() : null; },
    listUrl: (org) => `https://api.lever.co/v0/postings/${encodeURIComponent(org)}?mode=json`,
    jobs: (d) => (Array.isArray(d) ? d : []).map((j) => {
      const c = j.categories || {};
      return { id: String(j.id).toLowerCase(), title: j.text, listed: true,
        loc: [c.location, ...(c.allLocations || [])].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("; "),
        country: j.country || "" }; // an ISO code such as "IN": shared.js reads it
    }),
    applyUrl: (org, id) => `https://jobs.lever.co/${encodeURIComponent(org)}/${id}/apply`,
    key: (org, id) => `lever:${org}/${id}`.toLowerCase(),
    seedKey: "seed_lever",
  },
  // Keka: each company has its own address, <company>.keka.com/careers. The
  // form ends with a text CAPTCHA, so EDITH fills it and you submit it.
  keka: {
    label: "Keka",
    sites: ["keka.com/careers"],
    job: (href) => { const m = href.match(/^https?:\/\/([a-z0-9-]+)\.keka\.com\/careers\/(?:jobdetails|applyjob)\/(\d+)/i); return m ? { org: m[1].toLowerCase(), id: m[2] } : null; },
    org: (href) => { const m = href.match(/^https?:\/\/([a-z0-9-]+)\.keka\.com\/careers/i); return m && !/^(www|app|help|developers)$/i.test(m[1]) ? m[1].toLowerCase() : null; },
    // Two requests: the careers page holds the company id, the list needs it.
    fetchJobs: async (org) => {
      const base = `https://${encodeURIComponent(org)}.keka.com/careers`;
      const page = await withTimeout(fetch(base + "/"), 12000, "Keka careers page");
      if (!page.ok) return null;
      const id = ((await page.text()).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
      if (!id) return null;
      const r = await withTimeout(fetch(`${base}/api/embedjobs/default/active/${id}`), 12000, "Keka job list");
      if (!r.ok) return null;
      const d = await r.json();
      return (Array.isArray(d) ? d : []).map((j) => {
        const locs = j.jobLocations || [];
        const years = String(j.experience || "").match(/\d+(\.\d+)?/); // "3 - 5 Years" -> 3
        return { id: String(j.id), title: j.title, listed: true,
          loc: locs.map((l) => [l.name, l.city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ")).filter(Boolean).join("; "),
          country: [...new Set(locs.map((l) => l.countryName).filter(Boolean))].join("; "),
          minYears: years ? Number(years[0]) : null };
      });
    },
    applyUrl: (org, id) => `https://${encodeURIComponent(org)}.keka.com/careers/applyjob/${id}`,
    key: (org, id) => `keka:${org}/${id}`.toLowerCase(),
    seedKey: "seed_keka",
    manualSubmit: true,
  },
};
const providerOf = (href) => Object.keys(PROVIDERS).find((p) => PROVIDERS[p].org(href) || PROVIDERS[p].job(href)) || null;

// The public job list of one company, in one common shape.
// null: the list is not available.
const boardCache = new Map();
function boardJobs(prov, org) {
  const k = prov + ":" + org.toLowerCase();
  if (!boardCache.has(k)) {
    boardCache.set(k, (async () => {
      try {
        if (PROVIDERS[prov].fetchJobs) return await PROVIDERS[prov].fetchJobs(org);
        const r = await withTimeout(fetch(PROVIDERS[prov].listUrl(org)), 12000, "job list");
        if (!r.ok) return null;
        return PROVIDERS[prov].jobs(await r.json());
      } catch (e) {
        return null;
      }
    })());
  }
  return boardCache.get(k);
}

// undefined: the list is not available. null: the job is not on the list.
async function boardJob(prov, org, id) {
  const jobs = await boardJobs(prov, org);
  if (!jobs) return undefined;
  return jobs.find((j) => j.id === String(id).toLowerCase()) || null;
}

// A job title matches a role when it has every word of the role.
// "AI Engineer" matches "Applied AI Engineer" and "Software Engineer, AI".
const canon = (s) => " " + String(s).toLowerCase().replace(/machine learning/g, "ml").replace(/artificial intelligence/g, "ai")
  .replace(/software development engineer|\bsde\b|\bswe\b/g, "software engineer").replace(/developer/g, "engineer")
  .replace(/\bapm\b/g, "associate product manager").replace(/\bpm\b/g, "product manager")
  .replace(/[^a-z0-9+#]+/g, " ") + " ";
function matchesRole(title, roles) {
  const t = canon(title);
  return roles.some((r) => canon(r).trim().split(" ").filter(Boolean).every((w) => t.includes(" " + w + " ")));
}

// A job site answers 429 when one address sends too many form requests. Then
// the form keeps values that the site did not save, so the job must run again later.
chrome.webRequest.onCompleted.addListener((d) => {
  if (d.statusCode !== 429) return;
  const t = hunt.tabs.get(d.tabId);
  if (!t) return;
  if (!t.rateLimited) dbg(`  ${t.job.company}: the job site answered 429 (too many requests)`);
  t.rateLimited = true;
  if (Date.now() < hunt.pauseUntil) return;          // this pause is already counted
  hunt.rateHits++;
  hunt.cleanJobs = 0;
  const wait = Math.min(300000, 45000 * 2 ** (hunt.rateHits - 1)); // 45 s, 90 s, 180 s, 300 s
  hunt.pauseUntil = Date.now() + wait;
  dbg(`rate limit: pause ${wait / 1000} s`);
}, { urls: ["https://jobs.ashbyhq.com/*", "https://job-boards.greenhouse.io/*", "https://boards.greenhouse.io/*", "https://jobs.lever.co/*", "https://*.keka.com/*"] });

const boardLocation = (bj, allowed) => EdithShared.judgeLocation(bj.loc, allowed, bj.country, hunt.places);

const hunt = {
  running: false,
  stop: false,
  phase: "idle",
  message: "",
  queue: [],
  queued: new Set(),
  searchDone: false,
  started: 0,
  reviewTabs: 0,
  counts: {},
  tabs: new Map(),      // tabId -> { job, resolve, asked }
  googleTabId: null,
  pauseUntil: 0,        // no job starts before this time (rate limit)
  rateHits: 0,
  cleanJobs: 0,
  lastStart: 0,
  gate: Promise.resolve(),
  scanned: new Set(),
  newOrgs: new Set(),
};

function setStatus(phase, message) {
  hunt.phase = phase;
  hunt.message = message;
  dbg(`[${phase}] ${message}`);
}

// Debug log: shown in the popup, last 300 lines.
hunt.debug = [];
function dbg(line) {
  const t = new Date().toLocaleTimeString();
  hunt.debug.push(`${t} ${line}`);
  if (hunt.debug.length > 300) hunt.debug.shift();
  console.log("[hunt]", line);
  clearTimeout(dbg.timer);
  dbg.timer = setTimeout(() => chrome.storage.local.set({ huntDebug: hunt.debug.slice(-300) }), 1000);
}

// Rejects when a Chrome call does not return in time, so no step can hang.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}: no answer in ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function stopHunt(reason) {
  if (!hunt.running) return;
  hunt.stop = true;
  setStatus("stopping", reason || "stopping…");
  // Release every waiting job. Their tabs stay open.
  for (const t of hunt.tabs.values()) t.resolve({ status: "stopped", detail: reason || "" });
}

function buildQuery(role, locations, sites) {
  const locs = locations.map((l) => `"${l}"`);
  const siteExpr = sites.length > 1 ? "(" + sites.map((h) => "site:" + h).join(" OR ") + ")" : "site:" + sites[0];
  const words = (q) => q.split(/\s+/).filter(Boolean).length;
  // Google reads about 32 words. Drop locations from the end until the query fits.
  let q;
  while (true) {
    q = `${siteExpr} "${role}"` + (locs.length ? ` (${locs.join(" OR ")})` : "");
    if (words(q) <= 32 || !locs.length) break;
    locs.pop();
  }
  return q.slice(0, 2000);
}

function googleUrl(query, page, freshness) {
  const u = new URL("https://www.google.com/search");
  u.searchParams.set("q", query);
  u.searchParams.set("hl", "en");
  if (page > 0) u.searchParams.set("start", String(page * 10));
  if (freshness) u.searchParams.set("tbs", "qdr:" + freshness);
  return u.toString();
}

// Polls the tab until it shows a loaded Google page. Polling has no race with
// a "complete" event that fires before a listener is attached.
async function waitGoogleLoaded(tabId, ms) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    await sleep(500);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return { ok: false, why: "tab closed" }; }
    last = `${tab.status} ${tab.url || tab.pendingUrl || ""}`;
    if (tab.status === "complete" && /^https:\/\/[^/]*google\.[^/]+\/(search|sorry)/.test(tab.url || "")) return { ok: true, url: tab.url };
  }
  return { ok: false, why: "not loaded in " + ms / 1000 + "s, last: " + last.slice(0, 150) };
}

// Runs inside the Google results page.
function readSerp() {
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    let href = a.href;
    try {
      const u = new URL(href);
      if (/google\./.test(u.hostname) && u.pathname === "/url") href = u.searchParams.get("q") || u.searchParams.get("url") || href;
    } catch (e) {}
    if (!/jobs\.ashbyhq\.com\/|greenhouse\.io\/|jobs\.lever\.co\/|\.keka\.com\/careers/i.test(href)) continue;
    const h3 = a.querySelector("h3");
    links.push({ href, title: ((h3 && h3.innerText) || a.innerText || "").split("\n")[0].trim().slice(0, 200) });
  }
  // A CAPTCHA page has its own URL or form. Result snippets can contain words
  // like "not a robot", so page text counts only when the page has no results.
  const text = (document.body && document.body.innerText || "").slice(0, 2000);
  const captcha = location.pathname.startsWith("/sorry") ||
    !!document.querySelector("#captcha-form, form[action*='sorry']") ||
    (links.length === 0 && !document.querySelector("#search, #rso") && /unusual traffic|not a robot/i.test(text));
  return { captcha, links };
}

async function serp(tabId) {
  const res = await withTimeout(
    chrome.scripting.executeScript({ target: { tabId }, func: readSerp, injectImmediately: true }),
    10000, "read Google page");
  const r = res && res[0];
  return (r && r.result) || { captcha: false, links: [] };
}

// Keka lists the experience that a job needs ("8 - 11 Years"). A job that
// needs more than your years plus one is not for you.
const tooSenior = (bj, maxYears) => bj && bj.minYears != null && maxYears != null && bj.minYears > maxYears;

// A skip word does not skip a title when the word is part of a role that you
// search for and the title matches that role. "Manager" is a skip word, and
// the role "Product Manager" still finds "Associate Product Manager".
function isExcluded(title, exclude, roles) {
  const t = String(title).toLowerCase();
  const mine = roles.filter((r) => matchesRole(title, [r])).map((r) => canon(r));
  return exclude.some((re) => re.test(t) && !mine.some((r) => re.test(r.trim())));
}

const isFull = (cfg) => hunt.stop || hunt.started + hunt.queue.length >= cfg.maxJobs;

// Takes every job from one company's job list that matches a role, a
// location and the title filter. This is the scraper: one company found by
// Google can give many jobs.
async function scanBoard(prov, org, ctx) {
  const P = PROVIDERS[prov];
  const k = prov + ":" + org.toLowerCase();
  if (hunt.scanned.has(k)) return 0;
  hunt.scanned.add(k);
  const jobs = await boardJobs(prov, org);
  if (!jobs) return 0;
  let n = 0, inPlace = false;
  for (const bj of jobs) {
    const loc = boardLocation(bj, ctx.cfg.locations);
    if (loc.state !== "ok") continue;
    inPlace = true;
    if (isFull(ctx.cfg)) break;
    if (!bj.listed || !matchesRole(bj.title, ctx.cfg.roles)) continue;
    if (tooSenior(bj, ctx.maxYears)) { ctx.senior(P.key(org, bj.id)); continue; }
    const key = P.key(org, bj.id);
    if (hunt.queued.has(key) || ctx.seen[key]) continue;
    if (isExcluded(bj.title, ctx.exclude, ctx.cfg.roles)) {
      hunt.queued.add(key);
      hunt.found++;
      hunt.counts.excluded = (hunt.counts.excluded || 0) + 1;
      continue;
    }
    if (ctx.orgCount(k) >= ctx.cfg.perCompany) break;
    ctx.orgAdd(k);
    hunt.queued.add(key);
    hunt.found++;
    hunt.queue.push({ key, prov, role: "job list", title: bj.title, company: org, loc, url: P.applyUrl(org, bj.id) });
    n++;
  }
  if (inPlace) hunt.newOrgs.add(k); // a company that hires in your locations: remember it
  if (n) dbg(`${P.label} ${org}: ${n} matching job(s) from its job list (queue ${hunt.queue.length})`);
  return n;
}

async function saveOrgs() {
  if (!hunt.newOrgs.size) return;
  const { knownOrgs = {} } = await chrome.storage.local.get("knownOrgs");
  for (const o of hunt.newOrgs) knownOrgs[o] = new Date().toISOString().slice(0, 10);
  await chrome.storage.local.set({ knownOrgs });
}

async function searchPhase(cfg, seen) {
  // Use the open tab when it is a new tab or a Google tab. Otherwise open a new one.
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^(chrome:\/\/newtab|about:blank|https:\/\/www\.google\.)/.test(tab.url || tab.pendingUrl || "chrome://newtab")) {
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
  }
  hunt.googleTabId = tab.id;
  hunt.homeWindowId = tab.windowId;
  dbg(`Google tab ${tab.id}: ${tab.url || tab.pendingUrl}`);
  const provs = (cfg.sites && cfg.sites.length ? cfg.sites : ["ashby"]).filter((p) => PROVIDERS[p]);
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exclude = cfg.exclude.filter(Boolean)
    .map((w) => new RegExp("(^|[^a-z0-9])" + esc(w.toLowerCase()) + "($|[^a-z0-9])"));
  // Jobs per company: this run plus applications already submitted.
  const perOrg = new Map();
  for (const [key, st] of Object.entries(seen)) {
    if (st !== "submitted") continue;
    const o = key.split("/")[0];
    const k = o.includes(":") ? o : "ashby:" + o;
    perOrg.set(k, (perOrg.get(k) || 0) + 1);
  }
  const years = Number((await loadProfile()).total_experience_years);
  const ctx = { cfg, seen, exclude, orgCount: (k) => perOrg.get(k) || 0, orgAdd: (k) => perOrg.set(k, (perOrg.get(k) || 0) + 1),
    maxYears: Number.isFinite(years) ? years + 1 : null,
    senior: (key) => { if (!hunt.queued.has(key)) { hunt.queued.add(key); hunt.found++; hunt.counts.excluded = (hunt.counts.excluded || 0) + 1; } } };

  // Step 1: the job lists of the companies already known.
  const { knownOrgs = {}, ashbyOrgs = {} } = await chrome.storage.local.get(["knownOrgs", "ashbyOrgs"]);
  const known = new Map(); // "site:company" -> [site, company]
  const add = (p, o) => { if (provs.includes(p)) known.set(p + ":" + o.toLowerCase(), [p, o]); };
  for (const k of Object.keys(knownOrgs)) add(k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1));
  for (const o of Object.keys(ashbyOrgs)) add("ashby", o);
  const huntCfg = (await getConfig()).hunt;
  for (const p of provs) for (const o of EdithShared.toList(huntCfg[PROVIDERS[p].seedKey])) add(p, o);
  // Order: one company of each site in turn, so that no site uses the whole budget.
  const bySite = provs.map((p) => [...known.values()].filter(([q]) => q === p));
  const list = [];
  for (let i = 0; bySite.some((a) => i < a.length); i++) for (const a of bySite) if (i < a.length) list.push(a[i]);
  setStatus("searching", `Reading the job lists of ${list.length} known companies…`);
  for (let i = 0; i < list.length && !isFull(cfg); i += 6) {
    const part = list.slice(i, i + 6);
    await Promise.all(part.map(([p, o]) => boardJobs(p, o)));
    for (const [p, o] of part) await scanBoard(p, o, ctx);
  }
  await saveOrgs();
  dbg(`known companies gave ${hunt.queue.length + hunt.started} job(s)`);

  // Step 2: Google finds more companies.
  const sites = provs.flatMap((p) => PROVIDERS[p].sites);
  for (const role of cfg.roles) {
    const query = buildQuery(role, cfg.locations, sites);
    for (let page = 0; page < cfg.pages; page++) {
      if (isFull(cfg)) return;
      setStatus("searching", `Google: "${role}", page ${page + 1}`);
      const url = googleUrl(query, page, cfg.freshness);
      dbg("query: " + query);
      try {
        await withTimeout(chrome.tabs.update(tab.id, { url }), 10000, "open Google URL");
      } catch (e) {
        setStatus("searching", "Google tab failed: " + e.message + ". Search phase ended.");
        return;
      }
      const loaded = await waitGoogleLoaded(tab.id, PAGE_TIMEOUT_MS);
      if (!loaded.ok) {
        hunt.counts.search_errors = (hunt.counts.search_errors || 0) + 1;
        dbg("page load failed: " + loaded.why);
        if (loaded.why === "tab closed") return;
        break; // next role
      }
      await sleep(1000);
      let res;
      try {
        res = await serp(tab.id);
      } catch (e) {
        hunt.counts.search_errors = (hunt.counts.search_errors || 0) + 1;
        dbg("read failed: " + e.message);
        break; // next role
      }
      dbg(`page read: ${res.links.length} job-site links, captcha=${res.captcha}`);

      if (res.captcha) {
        setStatus("captcha", "Google shows a CAPTCHA. Solve it in the Google tab. Waiting 3 min…");
        try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
        const t0 = Date.now();
        while (Date.now() - t0 < CAPTCHA_WAIT_MS && !hunt.stop) {
          await sleep(3000);
          try { res = await serp(tab.id); } catch (e) { res = null; break; }
          if (!res.captcha) break;
        }
        if (!res || res.captcha) {
          setStatus("searching", "CAPTCHA not solved. Search phase ended. Applying to the jobs found.");
          return;
        }
      }

      let added = 0;
      const before = hunt.queue.length;
      // The companies on this page: load their job lists at the same time.
      const orgs = new Map();
      for (const l of res.links) {
        const p = providerOf(l.href);
        if (!p || !provs.includes(p)) continue;
        const o = PROVIDERS[p].org(l.href) || (PROVIDERS[p].job(l.href) || {}).org;
        if (o) orgs.set(p + ":" + o.toLowerCase(), [p, o]);
      }
      await Promise.all([...orgs.values()].map(([p, o]) => boardJobs(p, o)));
      for (const l of res.links) {
        const prov = providerOf(l.href);
        if (!prov || !provs.includes(prov)) continue;
        const P = PROVIDERS[prov];
        const j = P.job(l.href);
        if (!j) continue;
        const key = P.key(j.org, j.id);
        if (hunt.queued.has(key) || seen[key]) continue;
        if (isFull(cfg)) break; // not marked: a later run can take it
        hunt.queued.add(key); // also blocks excluded jobs from a second check
        hunt.found++;
        // The job list gives the exact title and the location. A job in the
        // wrong place is skipped here: no tab opens, and it does not use up
        // "Max jobs".
        const bj = await boardJob(prov, j.org, j.id);
        const title = (bj && bj.title) || l.title;
        if (isExcluded(title, exclude, cfg.roles)) {
          hunt.counts.excluded = (hunt.counts.excluded || 0) + 1;
          continue;
        }
        if (tooSenior(bj, ctx.maxYears)) {
          hunt.counts.excluded = (hunt.counts.excluded || 0) + 1;
          continue;
        }
        const loc = bj ? boardLocation(bj, cfg.locations) : null;
        const job = { key, prov, role, title, company: j.org, loc, url: P.applyUrl(j.org, j.id) };
        if (loc && loc.state === "bad") {
          hunt.counts.skipped_location = (hunt.counts.skipped_location || 0) + 1;
          dbg(`skip ${j.org} — ${title}: location ${loc.loc}`);
          await markSeen(job, "skipped_location");
          continue;
        }
        const ok = prov + ":" + j.org.toLowerCase();
        if (ctx.orgCount(ok) >= cfg.perCompany) continue;
        ctx.orgAdd(ok);
        hunt.queue.push(job);
        added++;
      }
      // Each company on the page: take its other matching jobs too.
      for (const [p, o] of orgs.values()) { if (isFull(cfg)) break; await scanBoard(p, o, ctx); }
      await saveOrgs();
      dbg(`added ${added} job(s) from Google, ${hunt.queue.length - before - added} from job lists (queue ${hunt.queue.length})`);
      if (res.links.length === 0) break; // no more results for this role
      await sleep(2500 + Math.random() * 2500); // pace Google to avoid a CAPTCHA
    }
  }
}

// Two workers can finish at the same moment. Writes go through one chain, so
// no history entry is lost (a lost entry could cause a second application).
let recordChain = Promise.resolve();
function record(job, status, detail) {
  recordChain = recordChain.then(() => recordNow(job, status, detail)).catch((e) => dbg("record failed: " + e.message));
  return recordChain;
}

function unsee(job) {
  recordChain = recordChain.then(async () => {
    const { huntSeen = {} } = await chrome.storage.local.get("huntSeen");
    delete huntSeen[job.key];
    await chrome.storage.local.set({ huntSeen });
  }).catch((e) => dbg("unsee failed: " + e.message));
  return recordChain;
}

function markSeen(job, status) {
  recordChain = recordChain.then(async () => {
    const { huntSeen = {} } = await chrome.storage.local.get("huntSeen");
    huntSeen[job.key] = status;
    await chrome.storage.local.set({ huntSeen });
  }).catch((e) => dbg("markSeen failed: " + e.message));
  return recordChain;
}

async function recordNow(job, status, detail) {
  hunt.counts[status] = (hunt.counts[status] || 0) + 1;
  // Toolbar badge: submitted count of this run.
  chrome.action.setBadgeText({ text: String(hunt.counts.submitted || 0) });
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  const { huntLog = [], huntSeen = {} } = await chrome.storage.local.get(["huntLog", "huntSeen"]);
  huntLog.unshift({ time: new Date().toISOString(), status, detail: String(detail || "").slice(0, 300),
    company: job.company, title: job.title, url: job.url });
  huntSeen[job.key] = status; // never open the same job again, whatever the result
  await chrome.storage.local.set({ huntLog: huntLog.slice(0, 1000), huntSeen });
}

// These tabs stay open for the user. All other tabs close.
const KEEP_OPEN = new Set(["needs_review", "filled", "submit_failed", "error", "stopped", "timeout"]);

// Opens the tab for one job. Option "separate window": each worker owns one
// hunt window and its job tab is the active tab there.
async function openJobTab(slot, url, ownWindow) {
  let tab = null;
  if (!ownWindow) {
    // Default: a background tab in the window that holds the Google tab.
    try {
      tab = await chrome.tabs.create({ url, active: false, windowId: hunt.homeWindowId || undefined });
    } catch (e) {
      tab = await chrome.tabs.create({ url, active: false });
    }
    await closePrevTab(slot);
    return tab;
  }
  if (slot.windowId != null) {
    try {
      tab = await chrome.tabs.create({ windowId: slot.windowId, url, active: true });
    } catch (e) {
      slot.windowId = null; // the user closed the hunt window
    }
  }
  if (!tab) {
    let win;
    try {
      win = await chrome.windows.create({ url, focused: true, width: 1100, height: 850,
        left: 60 + slot.idx * 90, top: 40 + slot.idx * 50 });
    } catch (e) {
      // Chrome rejects bounds that do not fit the screen. Let Chrome place the window.
      win = await chrome.windows.create({ url, focused: true });
    }
    slot.windowId = win.id;
    tab = win.tabs && win.tabs[0];
    if (!tab) [tab] = await chrome.tabs.query({ windowId: win.id });
  }
  await closePrevTab(slot); // after the new tab exists, so the window stays open
  return tab;
}

async function closePrevTab(slot) {
  if (slot.prevTabId == null) return;
  try { await chrome.tabs.remove(slot.prevTabId); } catch (e) {}
  slot.prevTabId = null;
}

// Chrome injects content.js by itself when site access is granted. This
// injects it again as a backup (content.js ignores a second copy). If Chrome
// refuses, the job ends at once with the reason, not after a long timeout.
async function ensureScript(tabId, done) {
  for (let i = 0; i < 40; i++) {            // wait up to 20 s for the page
    await sleep(500);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; } // tab closed
    if (tab.status === "complete" && /^https?:/.test(tab.url || "")) break;
  }
  const t = hunt.tabs.get(tabId);
  if (!t || t.loads > 0) return;            // the script already reported in
  try {
    // With withheld site access, Chrome holds this call and waits for a click
    // on the extension icon. The time limit turns that into an error.
    await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "content.js"] }), 6000, "inject script");
    dbg(`  ${t.job.company}: script injected by the background`);
  } catch (e) {
    dbg(`  ${t.job.company}: cannot run on the page: ${e.message}`);
    const denied = /cannot access|permission|manifest must request/i.test(e.message) ||
      !(await chrome.permissions.contains(SITE_ACCESS));
    done({ status: "error", detail: denied ? "no site access: " + NO_ACCESS_MSG : "inject failed: " + e.message });
    if (denied) stopHunt(NO_ACCESS_MSG);
  }
}

async function runJob(job, cfg, slot) {
  // A site with a CAPTCHA that you type (Keka): each job leaves a tab open for
  // you. When the open tabs reach the limit, its jobs wait for a later hunt.
  if (PROVIDERS[job.prov] && PROVIDERS[job.prov].manualSubmit && keptTabs.size >= MAX_KEPT_TABS) {
    hunt.started--;
    hunt.counts.waiting = (hunt.counts.waiting || 0) + 1;
    if (hunt.counts.waiting === 1) dbg(`${MAX_KEPT_TABS} tabs wait for you. More ${PROVIDERS[job.prov].label} jobs come in a later hunt.`);
    return;
  }
  // Mark the job as seen before the tab opens. If Chrome or the extension
  // stops in the middle, the next hunt does not apply to this job again.
  await markSeen(job, "started");
  let tab;
  try {
    tab = await withTimeout(openJobTab(slot, job.url, cfg.ownWindow), 20000, "open job tab");
  } catch (e) {
    dbg(`job ${job.company}: could not open tab: ${e.message}`);
    await record(job, "error", "could not open tab: " + e.message);
    return;
  }
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onRemoved.removeListener(onRem);
      const t = hunt.tabs.get(tab.id);
      if (t && t.submitClicked && r.status !== "submitted") {
        r.detail = "after the Submit click. " + (r.detail || "");
        r.afterSubmit = true; // a CAPTCHA or an email code can be the cause: the tab stays open for you
      }
      // The job site refused requests in this tab and Submit was not clicked: the
      // form is not reliable. The job runs again later.
      if (t && t.rateLimited && !t.submitClicked && !["submitted", "tab_closed", "stopped", "skipped_location", "closed"].includes(r.status)) {
        r = { status: "rate_limited", detail: "the job site answered 429 (too many requests)" };
      } else if (t && t.rateLimited && r.status !== "submitted") {
        r.detail = "the job site answered 429. " + (r.detail || "");
      }
      hunt.tabs.delete(tab.id);
      resolve(r);
    };
    const onRem = (id) => { if (id === tab.id) done({ status: "tab_closed", detail: "" }); };
    const timer = setTimeout(() => done({ status: "timeout", detail: `no result in ${JOB_TIMEOUT_MS / 1000}s` }), JOB_TIMEOUT_MS);
    chrome.tabs.onRemoved.addListener(onRem);
    hunt.tabs.set(tab.id, { job, resolve: done, loads: 0, submitClicked: false, submit: cfg.submit, locations: cfg.locations });
    ensureScript(tab.id, done);
  });
  dbg(`job ${job.company}: ${result.status} ${result.detail || ""}`);
  if (result.status === "rate_limited") {
    job.attempts = (job.attempts || 0) + 1;
    slot.prevTabId = tab.id;
    if (job.attempts < MAX_ATTEMPTS && !hunt.stop) {
      hunt.started--;            // this try does not use up "Max jobs"
      hunt.queue.push(job);      // again after the pause, at the end of the queue
      hunt.counts.retries = (hunt.counts.retries || 0) + 1;
      return;
    }
    await record(job, "rate_limited", `${job.attempts} tries. A later hunt tries this job again.`);
    await unsee(job);
    return;
  }
  hunt.cleanJobs++;
  if (hunt.cleanJobs >= 3) hunt.rateHits = 0; // the limit is over: short pauses again
  await record(job, result.status, result.detail);
  if (result.status === "tab_closed") return;
  // Submit was clicked but not confirmed (CAPTCHA puzzle, email code, form
  // error). The tab stays open so that you can complete it by hand. The hunt
  // continues. After MAX_KEPT_TABS such tabs, later ones close: the log keeps the link.
  // The same for a form with a question that only you can answer.
  if (((result.afterSubmit && ["submit_failed", "timeout"].includes(result.status)) || result.keep) && keptTabs.size < MAX_KEPT_TABS) {
    keptTabs.set(tab.id, job);
    dbg(`  ${job.company}: tab left open for you (${keptTabs.size} open)`);
    return;
  }
  // With submit off, the filled tabs are the result: they stay open.
  if ((cfg.keepReview || !cfg.submit) && KEEP_OPEN.has(result.status)) {
    hunt.reviewTabs++;
    if (hunt.reviewTabs >= MAX_REVIEW_TABS) stopHunt(`${MAX_REVIEW_TABS} tabs need your review. Hunt stopped.`);
  } else {
    slot.prevTabId = tab.id; // closed when the next job tab opens, or at the end
  }
}

// Tabs left open after a failed submit: tabId -> job. Not cleared by a new hunt.
const keptTabs = new Map();
const MAX_KEPT_TABS = 20;
chrome.tabs.onRemoved.addListener((id) => keptTabs.delete(id));

// You completed a kept tab by hand: the log entry becomes "submitted".
function manualDone(tabId) {
  const job = keptTabs.get(tabId);
  if (!job) return false;
  keptTabs.delete(tabId);
  recordChain = recordChain.then(async () => {
    const { huntLog = [], huntSeen = {} } = await chrome.storage.local.get(["huntLog", "huntSeen"]);
    const e = huntLog.find((x) => x.url === job.url);
    if (e) { e.status = "submitted"; e.detail = "completed by you after the automatic submit failed"; }
    huntSeen[job.key] = "submitted";
    await chrome.storage.local.set({ huntLog, huntSeen });
    dbg(`job ${job.company}: submitted by you`);
  }).catch(() => {});
  return true;
}

// One job start at a time: waits for the rate-limit pause and the minimum gap.
function pace() {
  hunt.gate = hunt.gate.then(async () => {
    let told = false;
    while (!hunt.stop) {
      const now = Date.now();
      const wait = Math.max(hunt.pauseUntil - now, hunt.lastStart + JOB_GAP_MS - now);
      if (wait <= 0) break;
      if (hunt.pauseUntil > now && !told) {
        told = true;
        setStatus("paused", `Job site rate limit. Waiting ${Math.ceil((hunt.pauseUntil - now) / 1000)} s, then the hunt continues.`);
      }
      await sleep(Math.min(wait, 1000));
    }
    hunt.lastStart = Date.now();
  });
  return hunt.gate;
}

async function worker(cfg, idx) {
  const slot = { idx, windowId: null, prevTabId: null };
  try {
    while (!hunt.stop) {
      const job = hunt.queue.shift();
      if (!job) {
        if (hunt.searchDone) return;
        await sleep(1000);
        continue;
      }
      if (hunt.started >= cfg.maxJobs) return;
      hunt.started++;
      await pace();
      if (hunt.stop) { hunt.started--; return; }
      setStatus("applying", `Applying ${hunt.started}: ${job.company} — ${job.title || job.role}`);
      try {
        await runJob(job, cfg, slot);
      } catch (e) {
        dbg(`job ${job.company}: ${e.message || e}`);
        await record(job, "error", String(e.message || e));
      }
    }
  } finally {
    await closePrevTab(slot);
  }
}

async function startHunt(cfg) {
  if (hunt.running) return { error: "A hunt is already running." };
  if (!(await isEnabled())) return { error: "The extension is OFF. Switch it on first." };
  if (!cfg.roles.length) return { error: "Enter at least one role." };
  const { profile, places } = await getConfig();
  const missing = EdithShared.missingRequired(profile);
  if (missing.length) return { error: "Your profile is incomplete (" + missing.join(", ") + "). Open Settings." };
  if (!(await readBundled("resume.pdf"))) return { error: "extension/resume.pdf not found. Put your resume there and reload the extension." };
  // Chrome can withhold site access ("Site access: On click"). Then the form
  // script never runs in the job tabs. Check before any tab opens.
  const origins = [...SITE_ACCESS.origins, ...(cfg.sites || []).flatMap((p) => SITE_ORIGINS[p] || [])];
  if (!(await chrome.permissions.contains({ origins }))) return { error: NO_ACCESS_MSG, needAccess: true };
  // Claude is optional. With the helper down, unknown questions stay empty.
  hunt.claude = false;
  if ((await chrome.storage.local.get({ useClaude: true })).useClaude) {
    try { await helper("/health"); hunt.claude = true; } catch (e) {}
  }

  Object.assign(hunt, { running: true, stop: false, queue: [], queued: new Set(), searchDone: false,
    started: 0, found: 0, reviewTabs: 0, counts: {}, tabs: new Map(), googleTabId: null, homeWindowId: null,
    pauseUntil: 0, rateHits: 0, cleanJobs: 0, lastStart: 0, gate: Promise.resolve(), scanned: new Set(), newOrgs: new Set(), startedAt: Date.now(), debug: [],
    places });
  dbg("config: " + JSON.stringify(cfg));
  dbg(hunt.claude ? "Claude: on (helper is running)" : "Claude: off (helper not running or switched off). Unknown questions stay empty.");
  setStatus("starting", "Starting…");
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

  (async () => {
    try {
      await dataReady;
      const { huntSeen = {} } = await chrome.storage.local.get("huntSeen");
      const workers = Array.from({ length: cfg.parallel }, (_, i) => worker(cfg, i));
      try {
        await searchPhase(cfg, huntSeen);
      } catch (e) {
        hunt.counts.search_errors = (hunt.counts.search_errors || 0) + 1;
      } finally {
        hunt.searchDone = true;
      }
      await Promise.all(workers);
      const c = hunt.counts;
      const summary = `Done. Opened ${hunt.started}. Submitted ${c.submitted || 0}, need review ${(c.needs_review || 0) + (c.filled || 0) + (c.submit_failed || 0)}, rate limited ${c.rate_limited || 0}, wrong location ${c.skipped_location || 0}, closed/no form ${(c.closed || 0) + (c.no_form || 0)}, errors ${(c.error || 0) + (c.timeout || 0)}.`;
      setStatus("done", (hunt.stop && hunt.message ? hunt.message + " " : "") + summary);
    } catch (e) {
      setStatus("done", "Hunt failed: " + (e.message || e));
    } finally {
      clearInterval(keepAlive);
      hunt.running = false;
      hunt.stop = false;
      hunt.endedAt = Date.now();
      setTimeout(showEnabled, 60000); // badge back to ON/OFF one minute after the run
    }
  })();
  return { ok: true };
}

function huntStatus() {
  return { running: hunt.running, phase: hunt.phase, message: hunt.message, queued: hunt.queue.length,
    started: hunt.started, found: hunt.found || 0, active: hunt.tabs.size, counts: hunt.counts,
    startedAt: hunt.startedAt || 0, debug: hunt.debug.slice(-80), endedAt: hunt.running ? 0 : hunt.endedAt || 0,
    current: [...hunt.tabs.values()].map((t) => `${t.job.company} — ${t.job.title || t.job.role}: ${t.step || "loading page…"}`) };
}

// ======================= messages =======================
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    switch (msg.type) {
      case "profile": return loadProfile();
      case "resume": return loadResume(tabId, msg.title);
      case "setup": return setupStatus();
      case "importConfig": return importConfigFile(true);
      case "fillActive": return fillActive();
      case "answer": {
        const { useClaude } = await chrome.storage.local.get({ useClaude: true });
        if (!useClaude) return { answers: {} };
        try {
          const { profile, instructions } = await claudeProfile();
          const { file: resume_file, track } = resumeByTab.get(tabId) || (await trackFor(tabId, msg.job && msg.job.title));
          const full = await loadProfile();
          const tp = EdithShared.trackProfile(profile, track);
          const extra = track === "pm" ? [instructions, full.pm_claude_instructions].filter(Boolean).join("\n") : instructions;
          return await helper("/answer", { questions: msg.questions, job: msg.job, profile: tp, instructions: extra, resume_file, track });
        } catch (e) {
          // Helper not running or Claude failed: the questions stay empty.
          if (hunt.running) dbg("  Claude not available: " + e.message);
          return { answers: {} };
        }
      }
      case "log": // optional: the helper writes log.csv when it runs
        try { return await helper("/log", msg.entry); } catch (e) { return { ok: false }; }
      case "huntProgress": {
        const t = hunt.tabs.get(tabId);
        if (t && msg.stage === "submit") t.submitClicked = true;
        if (t && t.step !== msg.msg) {
          t.step = msg.msg;
          dbg(`  ${t.job.company}: ${msg.msg}`);
        }
        return { ok: true };
      }
      case "saveJob":
        await chrome.storage.session.set({ ["job" + tabId]: msg.job });
        return { ok: true };
      case "getJob": {
        const saved = await getJob(tabId);
        if (saved) return { job: saved };
        const t = hunt.tabs.get(tabId);
        return { job: t ? { url: t.job.url, title: t.job.title, company: t.job.company } : null };
      }
      case "openLinks":
        for (const url of msg.urls) await chrome.tabs.create({ url, active: false });
        return { ok: true };
      // A hunt tab gets its instructions once. A reload of the same tab gets
      // "suppress", so it never fills or submits a second time.
      case "huntTab": {
        const t = hunt.tabs.get(tabId);
        if (!t) return keptTabs.has(tabId) ? { hunt: false, kept: true } : { hunt: false };
        t.loads++;
        // Loaded again after the Submit click: only check for the confirmation.
        if (t.submitClicked) return { hunt: true, afterSubmit: true, submit: false };
        // Loaded again before Submit: start over, at most 3 loads.
        if (t.loads > 3) {
          t.resolve({ status: "error", detail: "the page reloaded more than 3 times" });
          return { hunt: false, suppress: true };
        }
        return { hunt: true, submit: t.submit, locations: t.locations, loc: t.job.loc || null, site: t.job.prov || "ashby",
          manual: !!(PROVIDERS[t.job.prov] && PROVIDERS[t.job.prov].manualSubmit) };
      }
      case "huntManual": return { ok: manualDone(tabId) };
      case "huntGate": {
        const t = hunt.tabs.get(tabId);
        return { rateLimited: !!(t && t.rateLimited) };
      }
      case "sleep":
        await sleep(Math.max(0, Math.min(Number(msg.ms) || 0, 10000)));
        return { ok: true };
      case "huntResult": {
        const t = hunt.tabs.get(tabId);
        if (t) t.resolve({ status: msg.status, detail: msg.detail, keep: !!msg.keep });
        return { ok: true };
      }
      case "huntStart": return startHunt(msg.cfg);
      case "huntStop": stopHunt("Stopped by you."); return { ok: true };
      case "huntStatus": return huntStatus();
      case "huntReset":
        await chrome.storage.local.set({ huntSeen: {}, huntLog: [] });
        return { ok: true };
      default: return { error: "unknown message " + msg.type };
    }
  })().then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

// Fill the active tab. A tab that was open before EDITH loaded has no
// content script: inject it first (the click or the shortcut grants activeTab).
async function fillActive() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { error: "no active tab" };
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "fill" });
    return { ok: true };
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["shared.js", "content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "fill" });
      return { ok: true };
    } catch (e2) {
      return { error: "EDITH cannot run on this page: " + (e2.message || e2) };
    }
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "fill") fillActive();
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove("job" + tabId));
