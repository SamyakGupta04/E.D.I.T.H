// EDITH Settings page: edits the config in chrome.storage ("config").
const $ = (id) => document.getElementById(id);
let current = {};   // the config as loaded, with keys that the form does not show
let dirty = false;

const listText = (v, key) => (Array.isArray(v) ? v.join(key === "roles" ? "\n" : ", ") : v || "");
const markDirty = (on = true) => { dirty = on; $("dirty").textContent = on ? "Unsaved changes" : ""; };

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2500);
}

function fieldEl(prefix, [key, label, opt = {}]) {
  const wrap = document.createElement("div");
  wrap.className = "field" + (opt.type === "textarea" || (opt.type === "list" && key === "roles") ? " wide" : "");
  const id = prefix + "__" + key;
  const lab = document.createElement("label");
  lab.htmlFor = id;
  lab.textContent = label;
  wrap.appendChild(lab);
  let input;
  if (opt.type === "yesno" || opt.type === "select") {
    input = document.createElement("select");
    for (const o of opt.type === "yesno" ? ["", "Yes", "No"] : opt.options) {
      const op = document.createElement("option");
      op.value = o;
      op.textContent = o || "(not set)";
      input.appendChild(op);
    }
  } else if (opt.type === "textarea" || (opt.type === "list" && key === "roles")) {
    input = document.createElement("textarea");
  } else {
    input = document.createElement("input");
    input.type = opt.type === "number" ? "number" : opt.type === "email" ? "email" : opt.type === "url" ? "url" : "text";
    if (opt.type === "number") { input.min = "0"; input.step = "any"; }
  }
  input.id = id;
  input.dataset.section = prefix;
  input.dataset.key = key;
  input.dataset.type = opt.type || "text";
  if (opt.placeholder) input.placeholder = opt.placeholder;
  input.addEventListener("input", () => markDirty());
  wrap.appendChild(input);
  if (opt.help) {
    const h = document.createElement("small");
    h.textContent = opt.help;
    wrap.appendChild(h);
  }
  return wrap;
}

function build() {
  const form = $("form");
  const nav = $("nav");
  for (const sec of EDITH_SCHEMA) {
    const s = document.createElement("section");
    s.id = "sec-" + sec.id;
    s.innerHTML = `<h2></h2>${sec.help ? "<p></p>" : ""}<div class="grid"></div>`;
    s.querySelector("h2").textContent = sec.title;
    if (sec.help) s.querySelector("p").textContent = sec.help;
    const grid = s.querySelector(".grid");
    for (const f of sec.fields) grid.appendChild(fieldEl(sec.id, f));
    form.appendChild(s);
    nav.insertAdjacentHTML("beforeend", `<a href="#sec-${sec.id}"></a>`);
    nav.lastElementChild.textContent = sec.title;
  }
  for (const f of EDITH_HUNT_FIELDS) $("huntGrid").appendChild(fieldEl("hunt", f));
  nav.insertAdjacentHTML("beforeend", '<a href="#sec-custom">Custom answers</a><a href="#sec-hunt">Job hunt</a>');
}

function qaRow(q = "", a = "") {
  const row = document.createElement("div");
  row.className = "qa";
  row.innerHTML = '<input class="q" placeholder="Question, for example: percentage of time coding"><input class="a" placeholder="Answer"><button type="button" title="Remove">✕</button>';
  row.querySelector(".q").value = q;
  row.querySelector(".a").value = a;
  row.querySelector("button").onclick = () => { row.remove(); markDirty(); };
  row.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => markDirty()));
  $("qaList").appendChild(row);
}

function fill(cfg) {
  current = cfg || {};
  for (const el of document.querySelectorAll("[data-key]")) {
    const sec = current[el.dataset.section] || {};
    const v = sec[el.dataset.key];
    el.value = el.dataset.type === "list" ? listText(v, el.dataset.key) : v == null ? "" : String(v);
  }
  $("qaList").innerHTML = "";
  for (const c of current.custom_answers || []) qaRow(c.question, c.answer);
  if (!(current.custom_answers || []).length) qaRow();
  markDirty(false);
}

function read() {
  const cfg = JSON.parse(JSON.stringify(current)); // keeps keys that the form does not show
  for (const el of document.querySelectorAll("[data-key]")) {
    const sec = el.dataset.section;
    cfg[sec] = cfg[sec] && typeof cfg[sec] === "object" ? cfg[sec] : {};
    const raw = el.value.trim();
    cfg[sec][el.dataset.key] = el.dataset.type === "list" ? EdithShared.toList(raw) : raw;
  }
  cfg.custom_answers = [...document.querySelectorAll("#qaList .qa")]
    .map((r) => ({ question: r.querySelector(".q").value.trim(), answer: r.querySelector(".a").value.trim() }))
    .filter((c) => c.question && c.answer);
  return cfg;
}

async function status() {
  const s = await chrome.runtime.sendMessage({ type: "setup" });
  const chips = [];
  chips.push(s.missing.length ? ["err", "Missing: " + s.missing.join(", ")] : ["ok", "Profile complete"]);
  chips.push(s.resume ? ["ok", "resume.pdf found"] : ["err", "extension/resume.pdf missing"]);
  chips.push(s.resumeAi ? ["ok", "resume_ai.pdf found (AI and ML roles)"] : ["ok", "no resume_ai.pdf: one resume for all roles"]);
  if (s.resumePm) chips.push(["ok", "resume_apm.pdf found (product roles)"]);
  chips.push(s.configFile ? ["ok", "config.json found"] : ["", "No config.json (Settings only)"]);
  if (s.configError) chips.push(["err", s.configError]);
  try {
    await fetch("http://127.0.0.1:8765/health");
    chips.push(["ok", "Claude helper running"]);
  } catch (e) {
    chips.push(["warn", "Claude helper not running (optional)"]);
  }
  $("chips").innerHTML = "";
  for (const [tone, text] of chips) {
    const c = document.createElement("span");
    c.className = "chip " + tone;
    c.textContent = text;
    $("chips").appendChild(c);
  }
}

async function load() {
  const { config = {} } = await chrome.storage.local.get("config");
  fill(config);
  status();
}

async function save() {
  const cfg = read();
  await chrome.storage.local.set({ config: cfg });
  current = cfg;
  markDirty(false);
  toast("Saved. Open job tabs use the new values after a reload.");
  status();
}

$("save").onclick = save;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
});
$("addQa").onclick = () => { qaRow(); markDirty(); };

$("export").onclick = () => {
  const blob = new Blob([JSON.stringify(read(), null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "config.json";
  a.click();
  toast("Put the file in the extension folder to keep it with the code.");
};

$("import").onclick = () => $("importFile").click();
$("importFile").onchange = async () => {
  const file = $("importFile").files[0];
  if (!file) return;
  try {
    const cfg = JSON.parse(await file.text());
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("the file must hold one JSON object");
    fill(cfg);
    markDirty();
    toast("Imported. Click Save to keep it.");
  } catch (e) {
    toast("Import failed: " + e.message);
  }
  $("importFile").value = "";
};

$("reload").onclick = async () => {
  if (dirty && !confirm("Replace the form with extension/config.json? Unsaved changes are lost.")) return;
  const r = await chrome.runtime.sendMessage({ type: "importConfig" });
  if (r && r.ok) { await load(); toast("config.json loaded."); }
  else toast((r && r.error) || "config.json could not be read.");
};

window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

build();
load();
