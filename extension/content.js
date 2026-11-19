// EDITH content script: finds form controls, fills known fields from your
// profile (Settings / config.json), sends the rest to the local helper
// (Claude), and uploads extension/resume.pdf.
(() => {
  if (window.__edith) return;
  window.__edith = true;

  // ---------- where to run automatically ----------
  const ATS_HOSTS = [
    /myworkdayjobs\.com$/, /myworkdaysite\.com$/, /myworkday\.com$/,
    /amazon\.jobs$/, /greenhouse\.io$/, /lever\.co$/, /eightfold\.ai$/,
    /smartrecruiters\.com$/, /icims\.com$/, /successfactors\.(com|eu)$/,
    /oraclecloud\.com$/, /taleo\.net$/, /ashbyhq\.com$/, /workable\.com$/,
    /careers\.microsoft\.com$/, /jobs\.careers\.microsoft\.com$/, /keka\.com$/,
  ];
  const host = location.hostname;
  const onAts =
    ATS_HOSTS.some((r) => r.test(host)) ||
    (/(^|\.)google\.com$/.test(host) && location.pathname.includes("/careers")) ||
    (/(^|\.)linkedin\.com$/.test(host) && location.pathname.startsWith("/jobs"));

  const send = (type, data = {}) =>
    new Promise((resolve) => chrome.runtime.sendMessage({ type, ...data }, (r) => resolve(r || {})));
  // Chrome slows timers in hidden tabs (1 per second, then far less when the
  // page uses CPU). In a hidden tab the background script keeps the time: its
  // timers are not slowed. The local timer is the fallback.
  const localSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function sleep(ms) {
    const local = localSleep(ms);
    // The background answers after ms. A failed message answers at once with
    // no "ok": then only the local timer counts.
    const remote = send("sleep", { ms }).then((r) => (r && r.ok ? true : local));
    await Promise.race([local, remote]);
  }
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9+ ]/g, " ").replace(/\s+/g, " ").trim();

  // ---------- profile rules for text fields ----------
  // Order matters: the first match wins.
  const RULES = [
    [/confirm.*e-?mail|e-?mail/i, "email"],
    [/first\s*name|given\s*name|forename/i, "first_name"],
    [/last\s*name|family\s*name|surname/i, "last_name"],
    [/^(full\s*|legal\s*|your\s*)?name\*?$|full\s*name/i, "full_name"],
    [/country\s*(phone\s*)?code|dial(ing)?\s*code|phone\s*code/i, "phone_country_code"],
    // Ashby has one phone field with no country selector: use the full number.
    // These sites have one phone field: the full number with the country code.
    [/phone|mobile|contact\s*number|telephone/i, /(ashbyhq\.com|lever\.co|greenhouse\.io)$/.test(location.hostname) ? "phone_full" : "phone"],
    [/linked\s*-?\s*in/i, "linkedin"],
    [/github/i, "github"],
    [/website|portfolio|personal\s*(url|site)|blog/i, "website"],
    [/address\s*(line)?\s*1|street\s*address|^address\*?$/i, "address_line1"],
    [/currently located|current location|where are you (currently )?(based|located)|^location\*?$|location in which you reside|where do you (currently )?(live|reside)|city of residence|current city|place of residence/i, "city"],
    [/\bcity\b|\btown\b/i, "city"],
    [/\bstate\b|province|\bregion\b/i, "state"],
    [/postal|zip|pin\s*code|pincode/i, "postal_code"],
    [/^country\*?$|country\s*of\s*residence|country\/region/i, "country"],
    [/nationality|citizenship/i, "nationality"],
    [/notice\s*period/i, "notice_period_days"],
    [/expected\s*(ctc|salary|compensation|pay)|salary\s*expectation/i, "expected_salary"],
    [/current\s*(ctc|salary|compensation|pay)/i, "current_salary"],
    [/(total|years\s*of|relevant)\s*(work\s*)?experience/i, "total_experience_years"],
    [/current\s*(job\s*)?title|designation|job\s*title/i, "current_title"],
    [/current\s*(company|employer|organi[sz]ation)|employer\s*name|company\s*name/i, "current_company"],
    [/currently\s*(a\s*)?(student|enrolled)|are\s*you\s*(still\s*)?(a\s*)?student/i, "currently_student"],
    [/education(al)?\s*level|level\s*of\s*education|highest\s*(level\s*of\s*)?(education|degree)/i, "education_level"],
    [/university|college|school|institution|education history|^education\*?$/i, "university"],
    [/\bdegree\b|qualification/i, "degree"],
    [/major|field\s*of\s*study|areas?\s*(\(s\)\s*)?of\s*study|discipline|specialization/i, "major"],
    [/graduation\s*(year|date)|year\s*of\s*(passing|graduation)/i, "graduation_year"],
    [/\bc?gpa\b|(academic|aggregate|degree|graduation|college|university|b\.?\s?tech)\s*(percentage|score|grade|marks)|\bmarks\b/i, "gpa"],
    [/how\s*did\s*you\s*hear|source/i, "how_did_you_hear"],
  ];

  let profile = null;
  async function getProfile() {
    if (!profile) {
      const p = await send("profile");
      if (p.error) throw new Error(p.error);
      const missing = EdithShared.missingRequired(p);
      if (missing.length) throw new Error("profile is incomplete (" + missing.join(", ") + "). Open EDITH > Settings.");
      profile = p;
    }
    return profile;
  }

  // Rules are for short field labels. A long question can contain a rule word
  // by accident ("state/provincial" in a government-employee question), so long
  // labels go to Claude with the full profile instead.
  const MAX_RULE_LABEL = 80;

  function ruleValue(label) {
    if (label.length > MAX_RULE_LABEL) return undefined;
    for (const [re, key] of RULES) {
      if (re.test(label)) {
        let v = profile[key];
        if (Array.isArray(v)) v = v.join(", ");
        if (v === undefined || v === null || String(v).trim() === "") return null;
        return String(v);
      }
    }
    return undefined; // no rule
  }

  // A location list can hold cities, states or only countries. The answer is
  // the most exact place that the list has: city, then state, then country.
  const CITY_ALIAS = { gurugram: "Gurgaon", gurgaon: "Gurugram", bengaluru: "Bangalore", bangalore: "Bengaluru",
    mumbai: "Bombay", chennai: "Madras", kolkata: "Calcutta", "new delhi": "Delhi", delhi: "New Delhi" };
  function placeCandidates(label) {
    if (label.length > MAX_RULE_LABEL) return null;
    const hit = RULES.find(([re]) => re.test(label));
    const key = hit && hit[1];
    if (!["city", "state", "country"].includes(key)) return null;
    const city = String(profile.city || "").trim(), state = String(profile.state || "").trim(), country = String(profile.country || "").trim();
    const alias = CITY_ALIAS[city.toLowerCase()] || "";
    const list = key === "city" ? [city, alias, state, country] : key === "state" ? [state, country] : [country];
    const cands = list.filter(Boolean);
    if (!cands.length) return null;
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The chosen option must name one of these places: never "the first option".
    return { cands, must: new RegExp("(^|[^a-z])(" + cands.map(esc).join("|") + ")($|[^a-z])", "i") };
  }

  // ---------- reading the page ----------
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  const textOf = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
  const clean = (t) => (t || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim().slice(0, 300);

  function labelOf(el) {
    // A CAPTCHA box has no label of its own: the text near it is not its name.
    if (/captcha/i.test(`${el.id} ${el.name} ${el.placeholder || ""}`)) return "Captcha";
    let t = "";
    const by = el.getAttribute("aria-labelledby");
    if (by) t = by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" ");
    if (!t && el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) t = textOf(l);
    }
    if (!t) t = el.getAttribute("aria-label") || "";
    if (!t) t = textOf(el.closest("label"));
    if (!t) {
      // Walk up until a container has some text of its own.
      let p = el.parentElement;
      for (let i = 0; i < 4 && p && !t; i++, p = p.parentElement) {
        const first = textOf(p).split("\n").map((s) => s.trim()).find((s) => s.length > 1);
        if (first && first.length < 250) t = first;
      }
    }
    if (!t) t = el.placeholder || el.name || "";
    return clean(t);
  }

  function groupLabel(first) {
    const group = first.closest('[role="radiogroup"], fieldset, [role="group"]');
    if (group) {
      const legend = group.querySelector("legend");
      if (legend) return clean(textOf(legend));
      const by = group.getAttribute("aria-labelledby");
      if (by) return clean(by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" "));
      if (group.getAttribute("aria-label")) return clean(group.getAttribute("aria-label"));
    }
    // Fallback: first line of text above the options.
    let p = (group || first).parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const line = textOf(p).split("\n").map((s) => s.trim()).find((s) => s.length > 3);
      if (line && line.length < 300) return clean(line);
    }
    return "";
  }

  const isRequired = (el, label) =>
    el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label || "");

  const optionText = (o) => clean(textOf(o) || o.getAttribute("aria-label") || o.value);
  const PLACEHOLDER = /^(select|choose|please select|--|none selected|select one)/i;
  const YESNO = "button.ashby-application-form-input-yesno-option";

  function collect() {
    const items = [];
    const boxes = [];
    const radioGroups = new Map();
    const nodes = document.querySelectorAll(
      'input, textarea, select, button[aria-haspopup="listbox"], [role="combobox"]:not(input)'
    );
    for (const el of nodes) {
      if (el.closest("#edith-badge") || el.disabled || el.readOnly) continue;
      // react-select keeps a hidden copy of each required list for the browser check.
      if (el.getAttribute("aria-hidden") === "true" || el.closest(".iti__dropdown-content, .iti__country-list")) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "image", "reset", "password", "search", "file"].includes(type)) continue;
      // Ashby Yes/No questions keep their state in a hidden checkbox. The buttons are handled below.
      if (type === "checkbox" && el.closest(".ashby-application-form-field-entry") &&
          el.closest(".ashby-application-form-field-entry").querySelector(YESNO)) continue;
      if (type === "radio") {
        const key = el.name || (el.closest('[role="radiogroup"], fieldset') || el.parentElement);
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(el);
        continue;
      }
      if (type === "checkbox") {
        // Many forms hide the native box and draw their own. The label is then the visible part.
        const lab = el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
        if (visible(el) || visible(el.parentElement) || (lab && visible(lab))) boxes.push(el);
        continue;
      }
      if (!visible(el)) continue;
      if (tag === "select") {
        items.push({ kind: "select", el, label: labelOf(el), type: "select",
          options: [...el.options].map(optionText).filter((t) => t && !PLACEHOLDER.test(t)) });
      } else if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox") {
        items.push({ kind: "combo", el, label: labelOf(el), type: "select" });
      } else if (tag === "textarea") {
        items.push({ kind: "text", el, label: labelOf(el), type: "textarea" });
      } else if (el.closest(".react-datepicker-wrapper") || /pick (a )?date|mm\s*\/\s*dd|dd\s*\/\s*mm/i.test(el.placeholder || "")) {
        items.push({ kind: "text", el, label: labelOf(el), type: "date-picker" });
      } else {
        items.push({ kind: "text", el, label: labelOf(el), type: type || "text" });
      }
    }
    for (const radios of radioGroups.values()) {
      const shown = radios.filter((r) => visible(r) || visible(r.parentElement));
      if (!shown.length) continue;
      items.push({ kind: "radio", el: shown[0], radios: shown, label: groupLabel(shown[0]), type: "radio",
        options: shown.map((r) => labelOf(r)) });
    }
    // Checkboxes. Two or more boxes of one question are one multi-choice
    // group. A single box (consent, terms) is one item.
    const groups = new Map();
    for (const el of boxes) {
      let c = el.closest('.ashby-application-form-field-entry, fieldset, [role="group"]');
      // The container is a question only when it holds no other kind of field.
      if (c && c.querySelector('input:not([type="checkbox"]):not([type="hidden"]), textarea, select')) c = null;
      const key = c || (el.name && boxes.filter((b) => b.name === el.name).length > 1 ? "name:" + el.name : el);
      if (!groups.has(key)) groups.set(key, { c, list: [] });
      groups.get(key).list.push(el);
    }
    for (const { c, list } of groups.values()) {
      if (list.length === 1) {
        items.push({ kind: "checkbox", el: list[0], label: labelOf(list[0]), type: "checkbox" });
        continue;
      }
      const title = c && c.querySelector(":scope > label, :scope > legend, legend, .ashby-application-form-question-title");
      const label = clean(textOf(title && !title.querySelector("input") ? title : null)) || groupLabel(list[0]);
      items.push({ kind: "checkgroup", el: list[0], boxes: list, label, type: "checkbox-group",
        options: list.map((b) => labelOf(b)),
        required: list.some((b) => b.required || b.getAttribute("aria-required") === "true") ||
          /\*\s*$/.test(textOf(title)) || /required/i.test((title && title.className) || "") });
    }
    // Ashby Yes/No button pairs.
    for (const box of document.querySelectorAll(".ashby-application-form-field-entry")) {
      const buttons = [...box.querySelectorAll(YESNO)];
      if (buttons.length < 2 || !visible(buttons[0])) continue;
      const lab = box.querySelector("label");
      items.push({ kind: "yesno", el: buttons[0], buttons, label: clean(textOf(lab)), type: "radio",
        options: buttons.map((b) => clean(textOf(b))),
        required: /required/i.test((lab && lab.className) || "") || /\*\s*$/.test(textOf(lab)) });
    }
    return items;
  }

  function isEmpty(it) {
    const el = it.el;
    switch (it.kind) {
      case "text": return !el.value;
      case "select": return el.selectedIndex <= 0 || !el.value || PLACEHOLDER.test(optionText(el.options[el.selectedIndex]));
      case "radio": return !it.radios.some((r) => r.checked);
      case "checkbox": return !el.checked;
      case "checkgroup": return !it.boxes.some((b) => b.checked);
      case "yesno": return !it.buttons.some((b) => /_active_/.test(b.className));
      case "combo": {
        let shown = clean(el.value !== undefined && el.tagName === "INPUT" ? el.value : textOf(el));
        // react-select shows the selected value next to the input, not in it.
        for (let p = el.parentElement, i = 0; !shown && p && i < 5; i++, p = p.parentElement) {
          const v = p.querySelector('[class*="single-value"], [class*="multi-value"]');
          if (v) shown = clean(textOf(v));
          if (/control/.test(String(p.className))) break;
        }
        return !shown || PLACEHOLDER.test(shown);
      }
    }
    return false;
  }

  // ---------- writing to the page ----------
  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  // Lists that have "Male" or "Man" also have "Female" or "Woman", and a loose
  // match of "male" finds "Female". These answers must match a whole option.
  const EXACT = new Set(["male", "man", "no", "asian", "he"]);
  function pick(options, value) {
    const v = norm(value);
    if (!v) return -1;
    let i = options.findIndex((o) => norm(o) === v);
    if (i === -1 && EXACT.has(v)) { // whole first word only: "no" finds "No, I do not…", "male" does not find "Female"
      return options.findIndex((o) => norm(o).startsWith(v + " "));
    }
    if (i === -1) i = options.findIndex((o) => norm(o).startsWith(v) || v.startsWith(norm(o)));
    if (i === -1) i = options.findIndex((o) => norm(o).includes(v) || (norm(o).length > 2 && v.includes(norm(o))));
    return i;
  }

  // The visible options of an open list. The phone widget of Greenhouse keeps
  // its own country list in the page: that list is not part of a question.
  const listOptions = () => [...document.querySelectorAll('[role="option"]')].filter((o) => !o.closest(".iti") && visible(o));

  async function waitOptions(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(100);
      const opts = listOptions();
      if (opts.length) return opts;
    }
    return [];
  }

  // The full pointer sequence of a real click. react-select (Greenhouse) opens
  // its list only on this sequence, with the focus set in the middle.
  function pointerClick(el) {
    const ev = (type, Cls = MouseEvent) =>
      el.dispatchEvent(new Cls(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    if (document.activeElement === el) el.blur();
    ev("pointerdown", PointerEvent);
    ev("mousedown");
    el.focus();
    ev("pointerup", PointerEvent);
    ev("mouseup");
    ev("click");
  }

  async function openListbox(el) {
    if (el.tagName === "INPUT") pointerClick(el);
    else el.click();
    return waitOptions(900);
  }

  // Types into a searchable list without a blur: a blur closes the list.
  function typeInto(el, value) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const closeListbox = (el) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  // Ticks a checkbox. A click on the box is the normal way. Some forms react
  // only to a click on the label, so that is the second try.
  function tick(el) {
    el.click();
    if (el.checked) return;
    const lab = el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    if (lab) lab.click();
  }

  async function apply(it, value) {
    const el = it.el;
    if (value === null || value === undefined || value === "") return false;
    switch (it.kind) {
      case "text":
        if (it.type === "date-picker") {
          const d = new Date(value);
          if (isNaN(d)) return false;
          const p2 = (n) => String(n).padStart(2, "0");
          setNative(el, `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${d.getFullYear()}`);
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          return true;
        }
        if (el.type === "number") { // a number field refuses text such as "30 days"
          const num = String(value).match(/-?\d+(\.\d+)?/);
          if (!num) return false;
          value = num[0];
        }
        // Lever: the location field keeps a value only when it comes from its own list.
        if (el.id === "location-input" && /lever\.co$/.test(host)) {
          // Lever searches as you type. "Gurugram" can have no result while
          // "Gurgaon" has one, so the other name, the state and the country
          // are tried too. Only a result that names the place is taken.
          const names = [value, CITY_ALIAS[String(value).toLowerCase()], profile.state, profile.country].filter(Boolean);
          for (const name of [...new Set(names)]) {
            typeInto(el, name);
            // Lever starts its search on a key press, and takes a result on mousedown.
            el.dispatchEvent(new KeyboardEvent("keydown", { key: name.slice(-1), bubbles: true }));
            const hit = await waitFor(() => [...document.querySelectorAll(".dropdown-location")]
              .find((o) => visible(o) && norm(textOf(o)).split(" ").includes(norm(name).split(" ")[0])), 4000, 250);
            if (!hit) continue;
            hit.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
            await sleep(300);
            return el.value !== "";
          }
          typeInto(el, "");
          return false;
        }
        if (el.type === "date" && /^\d{2}\/\d{2}\/\d{4}$/.test(value)) value = value.split("/").reverse().join("-");
        setNative(el, value);
        return el.value !== ""; // false when the field refused the value
      case "select": {
        const opts = [...el.options];
        const i = pick(opts.map(optionText), value);
        if (i === -1 || (it.must && !it.must.test(optionText(opts[i])))) return false;
        setNative(el, opts[i].value);
        return true;
      }
      case "radio": {
        const i = pick(it.options, value);
        if (i === -1 || (it.must && !it.must.test(it.options[i]))) return false;
        it.radios[i].click();
        return true;
      }
      case "checkbox":
        if (/^(true|yes)$/i.test(value) && !el.checked) tick(el);
        return true;
      case "checkgroup": {
        // One or more options, separated by ";" or a new line.
        let done = false;
        for (const part of String(value).split(/\s*[;\n|]\s*/).filter(Boolean)) {
          const i = pick(it.options, part);
          if (i === -1 || (it.must && !it.must.test(it.options[i]))) continue;
          if (!it.boxes[i].checked) tick(it.boxes[i]);
          done = true;
        }
        if (done) await sleep(100);
        return done;
      }
      case "yesno": {
        const i = pick(it.options, value);
        if (i === -1) return false;
        it.buttons[i].click();
        await sleep(100);
        return true;
      }
      case "combo": {
        // 1. Open the list. A fixed list shows all its options.
        let opts = await openListbox(el);
        // A list that shows options before any typing is a fixed list. There,
        // only a real match counts: never "the first option" (that gave
        // "Accounting" for the discipline).
        const fixedList = opts.length > 0;
        let i = pick(opts.map(optionText), value);
        // A short fixed list shows all its options: typing cannot find more.
        // A long list can load more on search (schools), so typing is tried.
        if (i === -1 && el.tagName === "INPUT" && !(fixedList && opts.length < 30)) {
          // 2. Type the value. A typeahead then lists its matches, and its
          //    first match is the best one.
          typeInto(el, value);
          await sleep(300);
          opts = await waitOptions(2500);
          i = pick(opts.map(optionText), value);
          if (i === -1 && opts.length && !fixedList) i = 0;
        }
        if (i !== -1 && it.must && !it.must.test(optionText(opts[i]))) i = -1;
        if (i === -1) {
          if (el.tagName === "INPUT") typeInto(el, "");
          closeListbox(el);
          if (el.tagName === "INPUT") el.blur();
          return false;
        }
        opts[i].click();
        await sleep(200);
        return true;
      }
    }
    return false;
  }

  // One upload per application. Portals such as Amazon redraw the page after an
  // upload and show a new empty file input, so a per-element flag is not enough.
  const appKey = () => "edith:resume:" + host + ":" + ((location.href.match(/\d{5,}/) || [location.pathname])[0]);
  const resumeDone = () => {
    try { return sessionStorage.getItem(appKey()) === "1"; } catch (e) { return false; }
  };

  let uploadedName = "";   // the file name that the site shows after the upload
  let resumeError = "";
  async function uploadResume() {
    if (resumeDone()) return false;
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter((f) => !f.files || !f.files.length);
    // Ashby: the first file input is "Autofill from resume". The real field is
    // _systemfield_resume. Greenhouse and Lever also have a known resume input.
    const known = document.querySelector('#_systemfield_resume, input#resume[type="file"], #resume-upload-input, input[type="file"][name="resume"], input#resume-upload[type="file"]');
    const target = known ? (inputs.includes(known) ? known : null)
      : inputs.find((f) => !/cover|autofill/i.test(labelOf(f) + " " + f.id + " " + f.name));
    if (!target || target.dataset.edithUploaded) return false;
    try { sessionStorage.setItem(appKey(), "1"); } catch (e) {}
    const r = await send("resume", { title: document.title });
    if (!r.b64) {
      resumeError = r.error || "resume.pdf not found";
      try { sessionStorage.removeItem(appKey()); } catch (e) {}
      return false;
    }
    uploadedName = r.name;
    const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], r.name, { type: "application/pdf" }));
    target.files = dt.files;
    target.dataset.edithUploaded = "1";
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // ---------- job context ----------
  function companyFromHost() {
    const parts = host.split(".");
    if (/myworkday|eightfold|greenhouse|lever|smartrecruiters|icims|ashbyhq|workable/.test(host)) return parts[0];
    return parts.length > 1 ? parts[parts.length - 2] : host;
  }

  function captureJob() {
    if (window !== window.top) return;
    const formFields = document.querySelectorAll("input:not([type=hidden]), textarea, select").length;
    const main = document.querySelector("main, [role=main], article") || document.body;
    const text = textOf(main);
    if (formFields > 6 || text.length < 1200) return;
    if (!/job|career|position|role|opening/i.test(location.href + " " + document.title)) return;
    send("saveJob", { job: { url: location.href, title: document.title, company: companyFromHost(), description: text.slice(0, 6000) } });
  }

  // ---------- badge ----------
  function badge(msg, tone = "info") {
    if (window !== window.top && !document.querySelector("input, textarea, select")) return;
    if (window === window.top) progress(msg);
    let b = document.getElementById("edith-badge");
    if (!b) {
      b = document.createElement("div");
      b.id = "edith-badge";
      b.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:8px 12px;" +
        "border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer";
      b.title = "Click to fill again";
      b.onclick = () => fill(true);
      document.documentElement.appendChild(b);
    }
    b.style.background = { info: "#2563eb", ok: "#16a34a", warn: "#d97706", err: "#dc2626" }[tone];
    b.textContent = "EDITH: " + msg;
  }

  // ---------- built-in answers for common questions ----------
  // [label test, answer candidates (array or function), isYesNo, must]
  // Candidates are tried in order. For a dropdown or radio, the first one that
  // matches an option wins. A yes/no rule fills a text field only when the
  // label is a question ("Are you…", "Do you…").
  // An answer function gets (profile, label, item). It returns:
  //   an array: candidates.  undefined: this rule does not apply, try the next.
  //   ASK: stop here, use the profile rules and Claude.  null: leave empty for you.
  // "must" (a RegExp, or a function of the profile that gives one) is a check
  // that the chosen option must pass.
  const ASK = Symbol("ask");
  const DECLINE = ["Decline to self-identify", "Prefer not to say", "I don't wish to answer",
    "Decline to answer", "Prefer not to disclose", "I prefer not to answer", "Decline"];
  const DECLINE_MUST = /decline|prefer not|do not wish|don.?t wish|not to (say|answer|disclose)|choose not|rather not/i;
  const BOOL_Q = /^(are|do|did|have|has|will|would|can|could|is|were)\b/i;
  const known = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const toList = (v) => EdithShared.toList(v);
  // A Yes/No profile field. Empty: ASK.
  const yn = (v) => (/^yes$/i.test(String(v || "").trim()) ? ["Yes"] : /^no$/i.test(String(v || "").trim()) ? ["No"] : ASK);
  const isYes = (v) => /^yes$/i.test(String(v || "").trim());
  const isNo = (v) => /^no$/i.test(String(v || "").trim());
  const noticeDays = (p) => parseInt(p.notice_period_days, 10);
  const hasNotice = (p) => Number.isFinite(noticeDays(p));
  const startDate = (p) => new Date(Date.now() + noticeDays(p) * 86400000)
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // "2022-11" -> ["November", "Nov", "11"].
  function monthOf(ym) {
    const m = parseInt(String(ym || "").slice(5, 7), 10);
    if (!(m >= 1 && m <= 12)) return ASK;
    return [MONTHS[m - 1], MONTHS[m - 1].slice(0, 3), String(m).padStart(2, "0"), String(m)];
  }
  const yearOf = (ym) => (/^\d{4}/.test(String(ym || "")) ? [String(ym).slice(0, 4)] : ASK);

  // The option has every main word of one of the names.
  const STOP = new Set(["of", "the", "and", "in", "at", "for", "a", "an"]);
  const mainWords = (s) => norm(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
  function wordsMust(names, extra) {
    return { test: (o) => {
      if (extra && extra.test(o)) return true;
      const ow = new Set(mainWords(o));
      return names.some((n) => { const w = mainWords(n); return w.length > 0 && w.every((x) => ow.has(x)); });
    } };
  }
  // The option is one of the names, or starts with one of them as a whole word.
  // "Male" accepts "Male" and "Man", never "Female".
  function startMust(names) {
    const ns = names.map(norm).filter(Boolean);
    return { test: (o) => { const on = norm(o); return ns.some((n) => on === n || on.startsWith(n + " ")); } };
  }

  function jobInfo() {
    const t = (document.title || "").trim();
    const h1 = textOf(document.querySelector("h1")).split("\n")[0];
    let role = h1 || t, company = "";
    if (t.includes(" @ ")) [role, company] = t.split(" @ ").map((s) => s.trim());
    if (!company && /ashbyhq\.com$/.test(host)) company = decodeURIComponent(location.pathname.split("/")[1] || "");
    if (!company) company = companyFromHost();
    company = company.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return { role: role || "this", company };
  }

  const DEFAULT_TEMPLATE = "I am applying for the {role} role at {company}. {summary} {experience_focus} " +
    "I would like to bring this experience to {company}.";
  function pitch(p) {
    const j = jobInfo();
    // A product management job uses the product summary and cover letter.
    p = EdithShared.trackProfile(p, EdithShared.jobTrack(j.role + " " + document.title));
    if (!p.summary && !p.cover_letter_template) return ASK; // Claude writes it from the resume
    const vars = { role: j.role, company: j.company, summary: p.summary || "", experience_focus: p.experience_focus || "",
      name: p.full_name || "", first_name: p.first_name || "", current_title: p.current_title || "",
      current_company: p.current_company || "", years: p.total_experience_years || "" };
    const out = (p.cover_letter_template || DEFAULT_TEMPLATE).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return [out.replace(/\s+/g, " ").trim()];
  }

  const schoolNames = (p) => [p.university, ...toList(p.university_aliases), p.university_short].filter(Boolean);
  const majorNames = (p) => [p.major, ...toList(p.major_aliases)].filter(Boolean);

  function genderCands(v) {
    const g = norm(v);
    if (/^(male|man|cis ?(gender )?man)$/.test(g)) return ["Male", "Man", "Cisgender man", "Cis man"];
    if (/^(female|woman|cis ?(gender )?woman)$/.test(g)) return ["Female", "Woman", "Cisgender woman", "Cis woman"];
    if (/non ?binary/.test(g)) return [v, "Non-binary", "Nonbinary", "Non binary"];
    return [v];
  }

  const WORK_MODES = {
    onsite: [["On-site", "Onsite", "On site", "In-office", "In office", "Office"], /on-?\s?site|office/i],
    hybrid: [["Hybrid"], /hybrid/i],
    remote: [["Remote", "Fully remote", "Work from home"], /remote|from home/i],
  };
  const workMode = (p) => {
    const m = norm(p.work_mode_preference).replace(/[^a-z]/g, "").replace(/inoffice|office/, "onsite");
    return WORK_MODES[m] || null;
  };

  // "1-3 years", "3+", "Less than 2": the option that holds n years.
  function rangeOption(options, n) {
    if (!options || !Number.isFinite(n)) return null;
    for (const o of options) {
      const t = String(o).toLowerCase().replace(/\s+/g, " ").trim(); // keeps the "-" of "1-3
      let m;
      if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/))) { if (n >= +m[1] && n <= +m[2]) return o; }
      else if ((m = t.match(/(\d+(?:\.\d+)?)\s*\+|(?:more than|over|at least)\s*(\d+(?:\.\d+)?)/))) { if (n >= +(m[1] || m[2])) return o; }
      else if ((m = t.match(/(?:less than|under|fewer than)\s*(\d+(?:\.\d+)?)/))) { if (n < +m[1]) return o; }
      else if ((m = t.match(/^(\d+(?:\.\d+)?)( years?| yrs?)?$/))) { if (n === +m[1]) return o; }
    }
    return null;
  }

  // An answer that you wrote in Settings > Custom answers. A question is a
  // phrase (every word must be in the label) or a /regular expression/.
  function customAnswer(label) {
    const lw = " " + norm(label) + " ";
    for (const c of profile.custom_answers || []) {
      const q = String((c && c.question) || "").trim();
      if (!q || !known(c.answer)) continue;
      let hit = false;
      const m = q.match(/^\/(.+)\/([a-z]*)$/);
      if (m) {
        try { hit = new RegExp(m[1], [...new Set((m[2] + "i").split(""))].join("")).test(label); } catch (e) {}
      } else {
        const words = norm(q).split(" ").filter(Boolean);
        hit = words.length > 0 && words.every((w) => lw.includes(" " + w + " "));
      }
      if (hit) return [String(c.answer)];
    }
    return undefined;
  }

  // A label that is only your country name (a list of countries as checkboxes).
  const IS_MY_COUNTRY = { test: (l) => !!(profile && profile.country) && norm(l) === norm(profile.country) };

  const ANSWERS = [
    [/first and last name|full name/i, (p) => [p.full_name]],
    [/^school\*?$|^university\*?$|school name|name of (school|university|institution)/i,
      (p) => (schoolNames(p).length ? [...schoolNames(p), "Other"] : ASK),
      false, (p) => wordsMust(schoolNames(p), /^other\b/i)], // your school or "Other": never a similar name
    [/^degree\*?$|degree (type|level)|highest degree/i,
      (p) => [...toList(p.degree_aliases), p.degree, p.education_level].filter(Boolean)],
    [/^discipline\*?$|^major\*?$|field of study|specialization|area of study/i,
      (p) => (majorNames(p).length ? majorNames(p) : ASK), false, (p) => wordsMust(majorNames(p))],
    [/start (date )?year|year (started|of joining|of admission)|from year/i, (p) => yearOf(p.education_start)],
    [/end (date )?year|year (ended|of graduation|of completion|of passing)|graduation year|to year/i, (p) => yearOf(p.graduation_date)],
    [/start (date )?month/i, (p) => monthOf(p.education_start)],
    [/end (date )?month/i, (p) => monthOf(p.graduation_date)],
    [/pronunciation/i, (p) => [p.preferred_name || p.first_name]],
    [/preferred (first )?name|nick ?name/i, (p) => [p.preferred_name || p.first_name]],
    [/pronoun/i, (p) => (p.pronouns ? [p.pronouns, p.pronouns.split("/")[0]] : ASK)],
    [IS_MY_COUNTRY, ["Yes"], true],
    // Work-permit answers: true for the country that the question names. With
    // no country in the question, an answer is given only for a job in a
    // country where you can work (Settings > Location).
    [/without (the need for |requiring |needing |any |a )?(visa |employer |work |immigration )*sponsor/i, (p, l) => elig(l, true), true],
    [/sponsor/i, (p, l) => elig(l, false), true],
    [/authori[sz]ed to work|eligible to work|legally (able|permitted|allowed|entitled) to work|right to work|work authori[sz]ation|work permit/i,
      (p, l) => elig(l, true), true],
    // "Are you based in <your country>?" -> Yes. "Are you based in <another country>?" -> No.
    [/\b(based|located|residing|reside|resident|live|living)\b.{0,25}\bin\b/i,
      (p, l) => ({ home: ["Yes"], foreign: ["No"], none: ASK })[EdithShared.namedCountry(l, pl().home)], true],
    [/relocat/i, (p) => yn(p.willing_to_relocate), true],
    // "Do you plan to work remotely?": the office answer, unless your work mode is Remote.
    [/(plan|intend|prefer|want|wish|like) to work (remote|from (a )?remote|from home)/i,
      (p) => (/remote/i.test(p.work_mode_preference || "") ? ["Yes"]
        : ["No", "No, I intend to work from the office", "No, I plan to work from an office", "On-site", "Office"]),
      false, (p) => (/remote/i.test(p.work_mode_preference || "") ? /^yes\b|remote/i : /^no\b|office|on-?\s?site/i)],
    // Willingness, availability and commitment questions (travel, team meet-ups,
    // on-call, shifts, working hours). Not when the question names a country
    // where you cannot work: that is a work-permit matter.
    [/willing|able to commit|commit to|comfortable|are you (open|okay|ok|able|available|flexible|prepared|happy)|can you (commit|travel|attend|work)|travel|on-?call|meet in person/i,
      (p, l) => (EdithShared.namedCountry(l, pl().auth) === "foreign" ? undefined : yn(p.flexible_availability)), true],
    [/18 years|eighteen|legal age|over the age/i, (p) => yn(p.over_18), true],
    [/(previously|ever|before).*(employed|worked) (at|for|with|by)|(former|previous|past) .{0,30}employee|current or former employee/i,
      (p) => yn(p.previously_worked_here), true],
    [/(previously|already|ever) applied|applied .*before/i, (p) => [appliedBefore(p) ? "Yes" : "No"], true],
    [/relative|family member|related to (anyone|any|an|a|some)/i, (p) => yn(p.relatives_working_here), true],
    [/non-?compete|non-?solicit|restrictive covenant/i, (p) => yn(p.non_compete), true],
    [/criminal|convicted|felony/i, (p) => yn(p.criminal_record), true],
    [/government official|public official|politically exposed/i, (p) => yn(p.government_official), true],
    [/background (check|verification)|drug (test|screen)/i, (p) => yn(p.background_check_consent), true],
    [/on-?site|in[- ]office|in person|hybrid|office.*days|days.*(a|per) week|commut/i, (p) => yn(p.comfortable_onsite), true],
    [/remote|time ?zone|overlap|working hours|shifts?\b/i, (p) => yn(p.flexible_availability), true],
    [/english/i, (p) => (isYes(p.english_fluent) ? ["Yes", "Fluent", "Native or bilingual", "Professional"] : yn(p.english_fluent)), true],
    [/currently (a )?(student|enrolled)|still (a )?student/i, (p) => yn(p.currently_student), true],
    [/whatsapp|sms|text messages/i, (p) => yn(p.sms_consent), true],
    [/(were you|are you being|have you been) referred/i, (p) => yn(p.were_referred), true],
    // "I will use only my own words, no AI": that statement is yours to make.
    [/own words|without (the )?(use|help|assistance) of (ai|artificial)|use of (ai|artificial intelligence|chatgpt|generative)|ai[- ]generated|plagiari/i, (p, l) => askYou(l), true],
    [/i (agree|consent|acknowledge|confirm|certify|have read|understand)|privacy|terms (and|&) conditions|consent|acknowledg/i,
      (p) => yn(p.agree_to_terms), true],
    [/notice period/i, (p, l) => (!hasNotice(p) ? ASK : /week/i.test(l) ? [String(Math.round(noticeDays(p) / 7))]
      : /month/i.test(l) ? [String(Math.max(1, Math.round(noticeDays(p) / 30)))]
      : [`${noticeDays(p)} days`, `${noticeDays(p)}`])],
    [/(expected|desired) (annual )?(ctc|salary|compensation|pay|base)|salary expectation|compensation expectation/i,
      (p) => [/keka\.com$/.test(host) ? rupees(p.expected_salary) : p.expected_salary]],
    [/current (annual )?(ctc|salary|compensation|base)/i, (p) => [/keka\.com$/.test(host) ? rupees(p.current_salary) : p.current_salary]],
    // A yearly amount in rupees, when the question asks for INR.
    [/(current|present).{0,40}(compensation|salary|ctc).{0,30}(inr|₹|rupees)/i, (p) => [rupees(p.current_salary)]],
    [/(expected|desired).{0,40}(compensation|salary|ctc).{0,30}(inr|₹|rupees)/i, (p) => [rupees(p.expected_salary)]],
    // Date of birth, as day/month/year. A date field gets it in its own format.
    [/date of birth|\bdob\b|birth ?date|birthday/i, (p) => (known(p.date_of_birth) ? [String(p.date_of_birth).split("-").reverse().join("/")] : null)],
    // "Do you need a work visa?": No for a job in a country where you can work, Yes for the rest.
    [/(need|require) (a |an )?(work |employment )?visa\b/i, (p, l) => elig(l, false), true],
    // A CAPTCHA is for you. Nothing writes into it.
    [/captcha/i, () => null],
    // Keka: "Experience" is the number of years.
    [/^experience\*?$/i, (p) => [String(p.total_experience_years || "")]],
    [/available to join.{0,12}days|notice.{0,12}days|\(in days\)/i, (p) => (hasNotice(p) ? [String(noticeDays(p))] : ASK)],
    // "Do you have 3+ years of experience in X?": true answer from the profile.
    // More years than the profile has: no automatic answer. The tab stays open for you.
    [/(\d+)\s*\+?\s*(years|yrs)/i, (p, l) => (!known(p.total_experience_years) ? ASK
      : Number(l.match(/(\d+)\s*\+?\s*(years|yrs)/i)[1]) <= Number(p.total_experience_years) ? ["Yes"] : askYou(l)), true],
    [/work (mode|model|arrangement|style|set-?up|preference)|preferred (work(ing)? )?(mode|arrangement|environment)|(remote|hybrid|on-?site).{0,40}prefer|prefer.{0,40}(remote|hybrid|on-?site)/i,
      (p) => (workMode(p) ? workMode(p)[0] : ASK), false, (p) => (workMode(p) ? workMode(p)[1] : null)],
    [/years of (professional |industry |relevant |work |hands-on )?experience|how many years/i,
      (p, l, it) => {
        if (!known(p.total_experience_years)) return ASK;
        const r = rangeOption(it && it.options, Number(p.total_experience_years));
        return r ? [r] : [String(p.total_experience_years)];
      }],
    [/start date|when (can|could|would) you (be able to )?(start|join)|how soon|earliest.*(start|join)|available to (start|join)|joining date/i,
      (p) => (hasNotice(p) ? [startDate(p), `${noticeDays(p)} days`] : ASK)],
    // Voluntary self-identification. An empty profile field: "Prefer not to say".
    [/transgender/i, (p) => (known(p.transgender) ? yn(p.transgender) : DECLINE), false, (p) => (known(p.transgender) ? null : DECLINE_MUST)],
    [/sexual orientation|lgbt/i, (p) => (known(p.sexual_orientation) ? [p.sexual_orientation] : DECLINE), false,
      (p) => (known(p.sexual_orientation) ? null : DECLINE_MUST)],
    [/hispanic|latin[oa]/i, (p) => (isNo(p.hispanic_or_latino) ? ["No", "Not Hispanic or Latino", "I am not Hispanic or Latino"]
      : isYes(p.hispanic_or_latino) ? ["Yes", "Hispanic or Latino", "I am Hispanic or Latino"] : DECLINE), false,
      (p) => (isNo(p.hispanic_or_latino) ? /^no\b|not hispanic/i : isYes(p.hispanic_or_latino) ? /^yes\b|^hispanic|am hispanic/i : DECLINE_MUST)],
    [/\brace\b|ethnic/i, (p) => (toList(p.ethnicity).length ? toList(p.ethnicity) : DECLINE), false,
      (p) => (toList(p.ethnicity).length ? new RegExp("\\b" + norm(toList(p.ethnicity)[0]).split(" ")[0], "i") : DECLINE_MUST)],
    [/gender|\bsex\b/i, (p) => (known(p.gender) ? genderCands(p.gender) : DECLINE), false,
      (p) => (known(p.gender) ? startMust(genderCands(p.gender)) : DECLINE_MUST)],
    [/veteran/i, (p) => (isNo(p.veteran_status) ? ["I am not a protected veteran", "I am not a veteran", "Not a veteran", "No"]
      : isYes(p.veteran_status) ? ["I identify as one or more of the classifications of protected veteran", "I am a protected veteran", "Yes"]
      : DECLINE), false,
      (p) => (isNo(p.veteran_status) ? /not a (protected )?veteran|^no\b|^i am not/i
        : isYes(p.veteran_status) ? /^yes\b|identify as|am a (protected )?veteran/i : DECLINE_MUST)],
    [/disabilit/i, (p) => (isNo(p.disability) ? ["No, I do not have a disability and have not had one in the past", "No, I do not have a disability",
      "No, I don't have a disability", "I do not have a disability", "No"]
      : isYes(p.disability) ? ["Yes, I have a disability (or previously had a disability)", "Yes, I have a disability", "Yes"] : DECLINE), false,
      (p) => (isNo(p.disability) ? /^no\b|do not have|don.?t have/i : isYes(p.disability) ? /^yes\b/i : DECLINE_MUST)],
    // Your school in the text field that appears after "Other" in a school list.
    [/(other|specify|not listed).{0,60}(school|university|college|institution)|(school|university|college|institution).{0,60}(other|specify|not listed)/i,
      (p) => [p.university_short || p.university]],
    [/(which|what) (cities|locations|offices).{0,40}(open|willing|prefer)|open to (work|working) (in|from)|willing to work (in|from)|preferred (cities|locations)/i,
      (p, l) => (BOOL_Q.test(l) ? ["Yes"] : known(p.open_to_locations) ? [p.open_to_locations]
        : toList(p.preferred_locations).length ? [toList(p.preferred_locations).join(", ")] : ASK)],
    [/how did you (hear|find|learn|come across)|where did you (hear|find|see)|referral source/i,
      (p) => [p.how_did_you_hear, "LinkedIn", "Job board", "Google", "Online", "Internet", "Other"].filter(Boolean)],
    [/tech(nology|nical)? stack|(programming|coding) languages?|primary languages?|technologies (do|are) you/i,
      (p) => (toList(p.skills).length ? [toList(p.skills).slice(0, 10).join(", ")] : ASK)],
    [/location (that |which )?you are applying|preferred (work |job |office )?location|which (office|location)|location preference/i,
      (p) => (jobCity(p) ? [jobCity(p)] : ASK)],
    // "Do you have Python experience?": Yes when the profile has that skill.
    [/experience|proficien|familiar with|worked (with|on)|hands-on|have you (built|shipped|deployed|developed|contributed|used)/i,
      // A skill that the profile does not have: no automatic answer. The tab stays open for you.
      (p, l) => (skillHit(p, l) ? ["Yes"] : askYou(l)), true],
    [/cover letter|why .*(join|interested|apply|company|role|us\b|work (at|with|here))|tell us (a (bit|little) )?(more )?about (yourself|you\b)|about yourself|introduce yourself|additional information|anything else|what excites/i,
      (p) => pitch(p)],
  ];

  // ---------- job location guard ----------
  let locState = "ok";
  let locHome = true; // outside a hunt, you chose the form yourself
  let placesCache = null;
  const pl = () => (profile ? placesCache || (placesCache = EdithShared.places(profile)) : EdithShared.places({}));

  function jobLocation() {
    for (const h of document.querySelectorAll("h2, h3")) {
      if (clean(textOf(h)).toLowerCase() !== "location") continue;
      const sec = h.parentElement;
      return clean(textOf(sec).replace(/^\s*location\s*/i, ""));
    }
    return "";
  }

  // yesIfEligible: "Yes" is the answer of a person who can work there.
  function elig(label, yesIfEligible) {
    const c = EdithShared.namedCountry(label, pl().auth);
    const pos = yesIfEligible ? "Yes" : "No", neg = yesIfEligible ? "No" : "Yes";
    if (c === "home") return [pos];
    if (c === "foreign") return [neg];
    return locHome ? [pos] : null; // no country named: true only for a job where you can work
  }
  const ELIG_Q = /right to work|authori[sz]ed to work|eligible to work|legally .{0,20}work|work (permit|visa|authori[sz]ation)|sponsor|\b(based|located|residing|reside|resident|live|living)\b.{0,25}\bin\b|citizen/i;

  // The city of this job, for "which location are you applying for".
  function jobCity(p) {
    const loc = jobLocation().toLowerCase();
    const hit = pl().cities.find((t) => EdithShared.hasAny(loc, [t]));
    const city = hit || String(toList(p.preferred_locations).filter((l) => !/^remote$/i.test(l))[0] || p.city || "").toLowerCase();
    return city.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // True when the question names a skill or keyword from the profile.
  function skillHit(p, label) {
    const l = " " + label.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ") + " ";
    const words = [...toList(p.skills), ...toList(p.skill_keywords)].map((s) => s.toLowerCase());
    return words.some((w) => { const k = w.replace(/[^a-z0-9+#.]+/g, " ").trim(); return k && l.includes(" " + k + " "); });
  }

  // True when previous_applications names the company of this job.
  function appliedBefore(p) {
    const c = norm(jobInfo().company);
    return !!c && toList(p.previous_applications).some((a) => norm(a).includes(c));
  }

  // Questions that only you can answer. The form is not submitted, and its tab stays open.
  const yourQuestions = new Set();
  function askYou(label) {
    yourQuestions.add(label);
    return null;
  }

  // undefined: use the profile rules and Claude. null: leave empty. array: candidates.
  // "15 LPA fixed + 3 lakh ESOPs" -> "1500000": a yearly amount in rupees, for a field that takes a plain number.
  function rupees(text) {
    const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|l\b|cr|crores?)?/i);
    if (!m) return "";
    const unit = (m[2] || "").toLowerCase();
    return String(Math.round(Number(m[1]) * (/^cr/.test(unit) ? 1e7 : unit ? 1e5 : 1)));
  }

  function answerFor(it) {
    const custom = customAnswer(it.label);
    if (custom) { it.must = null; return custom; }
    for (const [re, ans, isBool, must] of ANSWERS) {
      if (!re.test(it.label)) continue;
      if (isBool && !["yesno", "radio", "checkbox"].includes(it.kind) && !BOOL_Q.test(it.label)) continue;
      if (it.kind === "checkbox" && !isBool) continue;
      const v = typeof ans === "function" ? ans(profile, it.label, it) : ans;
      if (v === undefined) continue; // this rule has no answer here: try the next rule
      if (v === ASK) return undefined;
      if (v === null) return null;
      const list = v.filter(known);
      if (!list.length) return undefined;
      it.must = (typeof must === "function" ? must(profile) : must) || null; // the chosen option must match this
      return list;
    }
    return undefined;
  }

  // ---------- progress report to the hunt (shown in the popup) ----------
  function progress(msg) {
    if (huntMode) send("huntProgress", { msg });
  }

  // ---------- main fill ----------
  const attempted = new WeakSet();
  const askedLabels = new Set();
  let running = false;
  let loggedSubmit = false;
  let huntMode = false;   // the hunt controller clicks Submit, not autoNext
  let lastError = null;

  const missingRequired = () =>
    collect().filter((it) => isEmpty(it) && it.kind !== "checkbox" && (it.required || isRequired(it.el, it.label)));

  // Returns true when the pass changed the page.
  async function fill(manual = false) {
    if (running) return false;
    running = true;
    lastError = null;
    resumeError = "";
    const t0 = performance.now();
    try {
      await getProfile();
      const settings = huntMode ? { autoAdvance: false, autoSubmit: false }
        : await chrome.storage.local.get({ autoAdvance: false, autoSubmit: false });
      const { useClaude } = await chrome.storage.local.get({ useClaude: true });
      if (manual) askedLabels.clear();
      const items = collect().filter((it) => it.label && isEmpty(it) && (manual || !attempted.has(it.el)));
      const pendingFile = !resumeDone() && document.querySelector('input[type="file"]:not([data-edith-uploaded])');
      if (!items.length && !pendingFile) return;
      badge("filling…");

      let byRule = 0, byClaude = 0;
      const questions = [];
      for (const it of items) {
        attempted.add(it.el);
        // Start-date pickers: today + notice period.
        if (it.type === "date-picker" && hasNotice(profile) && /start|join|available|availability|notice|begin/i.test(it.label)) {
          const d = new Date(Date.now() + noticeDays(profile) * 86400000);
          if (await apply(it, d.toISOString().slice(0, 10) + "T12:00:00")) { byRule++; continue; }
        }
        // Hardcoded answers first.
        const cands = it.type === "date-picker" ? undefined : answerFor(it);
        if (cands === null) continue;
        // In a hunt, fields are filled with a short gap. Each field makes Ashby
        // save a value, and a burst of saves meets Ashby's rate limit.
        if (huntMode) await sleep(250);
        if (cands) {
          let ok = false;
          for (const c of cands) if (await apply(it, c)) { ok = true; break; }
          if (ok) { byRule++; continue; }
        }
        // Location lists: city, then state, then country, whichever the list has.
        const place = it.kind !== "text" && it.kind !== "checkbox" ? placeCandidates(it.label) : null;
        if (place) {
          it.must = place.must;
          let ok = false;
          for (const c of place.cands) if (await apply(it, c)) { ok = true; break; }
          if (ok) { byRule++; continue; }
          it.must = null;
        }
        // A group of place names as checkboxes ("which countries / offices"):
        // tick your country and your home cities.
        if (it.kind === "checkgroup") {
          const mine = [profile.country, profile.city, CITY_ALIAS[String(profile.city || "").toLowerCase()],
            ...toList(profile.preferred_locations)].filter(Boolean).filter((v) => !/^remote$/i.test(v));
          const hits = it.options.filter((o) => mine.some((m) => norm(o) === norm(m)));
          if (hits.length && (await apply(it, hits.join(";")))) { byRule++; continue; }
        }
        if (it.kind !== "checkbox" && it.kind !== "checkgroup" && it.type !== "textarea") {
          const v = ruleValue(it.label);
          if (v === null) continue; // the profile field is empty: leave it for you
          if (v !== undefined && (await apply(it, v))) { byRule++; continue; }
        }
        if (!useClaude || askedLabels.has(it.label)) continue;
        if (it.kind === "combo" && !it.options) {
          const opts = await openListbox(it.el);
          it.options = opts.map(optionText).filter((t) => t && !PLACEHOLDER.test(t));
          closeListbox(it.el);
          if (it.el.tagName === "INPUT") it.el.blur();
          await sleep(100);
        }
        askedLabels.add(it.label);
        it.qid = "q" + questions.length;
        questions.push({ id: it.qid, label: it.label, type: it.type, options: it.options && it.options.slice(0, 300) });
      }

      const resumeUp = uploadResume();
      if (questions.length) {
        badge(`filled ${byRule}, asking Claude ${questions.length}…`);
        const got = await send("getJob");
        const job = got.job || { url: location.href, title: document.title, company: companyFromHost() };
        // Short answers (Haiku) and long answers (Sonnet) go in separate requests,
        // so the short ones fill while the long ones are still being written.
        const asked = items.filter((x) => x.qid);
        const batches = [questions.filter((q) => q.type !== "textarea"), questions.filter((q) => q.type === "textarea")];
        await Promise.all(batches.filter((b) => b.length).map(async (batch) => {
          const r = await send("answer", { questions: batch, job });
          if (r.error) throw new Error(r.error);
          for (const it of asked.filter((x) => x.qid in r.answers)) {
            if (await apply(it, r.answers[it.qid])) {
              byClaude++;
              it.el.style.outline = "2px solid #22c55e"; // Claude answer: review it
            }
          }
        }));
      }
      const uploaded = await resumeUp;
      if (!manual && !uploaded && byRule + byClaude === 0 && !questions.length) {
        badge("nothing new to fill", "ok");
        return;
      }

      const missing = missingRequired();
      missing.forEach((it) => (it.el.style.outline = "2px solid #f59e0b"));
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const summary = `${byRule} from profile, ${byClaude} from Claude, ${secs}s` + (resumeError ? `. Resume: ${resumeError}` : "");
      if (missing.length) {
        badge(`${summary}. ${missing.length} required field(s) need you (orange).`, "warn");
      } else {
        badge(summary, "ok");
        await autoNext(settings);
      }
      return true;
    } catch (e) {
      lastError = String(e.message || e);
      badge(lastError, "err");
    } finally {
      running = false;
    }
  }

  function findButton(re) {
    return [...document.querySelectorAll('button, input[type="submit"], [role="button"], a[role="button"]')]
      .filter(visible)
      .find((b) => re.test(clean(textOf(b) || b.value || b.getAttribute("aria-label"))));
  }

  async function autoNext(settings) {
    if (settings.autoSubmit) {
      const submit = findButton(/^(submit|submit application|apply|send application)$/i);
      if (submit) { await sleep(300); submit.click(); return; }
    }
    if (settings.autoAdvance) {
      const next = findButton(/^(next|continue|save and continue|review)$/i);
      if (next) { await sleep(300); next.click(); }
    }
  }

  // ---------- confirmation logging ----------
  const DONE = /thank(s| you) for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received)|successfully (applied|submitted)/i;
  const isDone = () => !!document.querySelector(".ashby-application-form-success-container") ||
    (/greenhouse\.io$/.test(host) && /\/confirmation/.test(location.pathname)) ||
    (/lever\.co$/.test(host) && /\/thanks/.test(location.pathname)) ||
    DONE.test(textOf(document.body).slice(0, 20000));
  async function checkSubmitted() {
    if (loggedSubmit || window !== window.top) return;
    if (!isDone()) return;
    loggedSubmit = true;
    const { job } = await send("getJob");
    send("log", { entry: { company: (job && job.company) || companyFromHost(), title: (job && job.title) || document.title,
      url: (job && job.url) || location.href, status: "submitted" } });
    badge("application submitted and logged", "ok");
  }

  // ---------- hunt controller (Ashby, Greenhouse and Lever tabs opened by the hunt) ----------
  async function waitFor(test, ms, step = 500) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = test();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // The resume field of Ashby, Greenhouse and Lever.
  const RESUME_INPUT = '#_systemfield_resume, input#resume[type="file"], #resume-upload-input, input[type="file"][name="resume"], input#resume-upload[type="file"]';
  // The site shows the file name near the field when the upload is complete.
  function resumeState() {
    const input = document.querySelector(RESUME_INPUT);
    if (!input) return "none";
    const kekaName = document.querySelector('input#resume[type="text"]'); // Keka shows the file name in a text field
    if (kekaName && /\.(pdf|docx?)$/i.test(kekaName.value || "")) return "done";
    const ok = document.querySelector(".resume-upload-success"); // Lever
    if (ok && visible(ok)) return "done";
    let box = input.closest(".ashby-application-form-field-entry") || input.parentElement;
    for (let i = 0; i < 4 && box && box !== document.body; i++, box = box.parentElement) {
      if (textOf(box).toLowerCase().includes((uploadedName || ".pdf").toLowerCase())) return "done";
      if (box.classList.contains("ashby-application-form-field-entry")) break;
    }
    return "pending";
  }

  // The browser's own required-field check. Ashby relies on it at submit.
  function invalidFields() {
    const bad = [];
    for (const f of document.querySelectorAll("form")) {
      for (const el of f.querySelectorAll(":invalid")) {
        if (el.tagName === "FIELDSET" || el.tagName === "FORM") continue;
        // A checkbox group is complete when one box of the group is ticked.
        if ((el.type === "checkbox" || el.type === "radio") && el.name &&
            f.querySelector(`input[name="${CSS.escape(el.name)}"]:checked`)) continue;
        bad.push(labelOf(el) || el.name || el.type);
      }
    }
    return bad;
  }

  // A tab left open after a failed submit: no fill and no click. It only
  // watches for the confirmation after you complete the form by hand.
  let watching = false;
  async function watchManual(msg) {
    if (watching) return;
    watching = true;
    huntMode = true; // keeps autoNext off in this tab
    badge(msg || "submit not confirmed. Complete the CAPTCHA or the code, then click Submit. This tab stays open.", "warn");
    for (let i = 0; i < 600; i++) {          // up to 30 minutes
      if (isDone()) {
        await send("huntManual");
        badge("application submitted by you. Recorded.", "ok");
        return;
      }
      await localSleep(3000);
    }
  }

  async function huntRun(h) {
    huntMode = true;
    const submit = h.submit;
    const report = (status, detail = "", keep = false) => {
      badge(`hunt: ${status}${detail ? " — " + detail : ""}`, status === "submitted" ? "ok" : "warn");
      return send("huntResult", { status, detail: String(detail).slice(0, 300), keep: !!keep });
    };
    try {
      // This tab loaded again after the Submit click: only look for the confirmation.
      if (h.afterSubmit) {
        badge("hunt: page reloaded after Submit, checking confirmation…");
        if (await waitFor(isDone, 20000, 1000)) return report("submitted", "confirmed after reload");
        await report("submit_failed", "page reloaded after Submit, no confirmation");
        return watchManual();
      }
      // A page that loaded again has an empty form: the resume must be attached again.
      try { sessionStorage.removeItem(appKey()); } catch (e) {}
      badge("hunt: waiting for the form…");
      const FORM = { ashby: "#_systemfield_email, #_systemfield_name, .ashby-application-form-field-entry",
        greenhouse: "#application-form #first_name, form #first_name, #application-form input",
        lever: 'form#application-form input[name="name"], form input[name="email"]',
        keka: '#firstName, input[name="firstName"]' }[h.site || "ashby"];
      const form = await waitFor(() => document.querySelector(FORM), 25000);
      if (!form) {
        const closed = /no longer (accepting|available)|not found|job (is )?closed|position (has been )?filled/i.test(textOf(document.body));
        return report(closed ? "closed" : "no_form", location.href);
      }
      await sleep(1000);
      // Location guard: do not apply to a job outside the allowed locations.
      // The background sends the location from Ashby's job list when it has it.
      await getProfile();
      const lc = h.loc || EdithShared.judgeLocation(jobLocation(), h.locations || [], "", pl());
      locState = lc.state;
      locHome = !!lc.home;
      if (lc.state === "bad") return report("skipped_location", lc.loc);
      // A form that asks for the right to work or a home in another country is not for you.
      // A job in your country can still ask about another country (US sponsorship): that gets the true answer.
      const foreignQ = locHome ? null
        : collect().map((it) => it.label).find((l) => ELIG_Q.test(l) && EdithShared.namedCountry(l, pl().auth) === "foreign");
      if (foreignQ) return report("skipped_location", "the form asks: " + foreignQ);
      badge(`hunt: location "${lc.loc || "not shown"}" (${lc.state})`);
      // The application page also shows the job description. Give it to Claude.
      const main = document.querySelector("main, [role=main]") || document.body;
      await send("saveJob", { job: { url: location.href, title: document.title, company: companyFromHost() === "jobs" ? location.pathname.split("/")[1] : companyFromHost(),
        description: textOf(main).slice(0, 6000) } });
      // Keka and Lever read the resume and then set fields from it (Lever also
      // clears the location). So the resume goes first, and EDITH fills after it.
      if (h.site === "keka" || h.site === "lever") {
        badge("hunt: attaching the resume first…");
        await getProfile();
        await uploadResume();
        await waitFor(() => resumeState() === "done", 15000, 1000);
        await sleep(3000);
        // The phone country code is a plain list of codes with no label (Keka).
        const code = document.getElementById("mobilePhone.countryCode");
        const want = String(profile.phone_country_code || "").trim();
        const opt = code && want && [...code.options].find((o) => clean(o.text) === want || o.value === want);
        if (opt && code.value !== opt.value) setNative(code, opt.value);
      }
      // Pass 1 fills everything. Later passes fill fields that appear after an answer.
      // At most 4 passes: no endless loop.
      for (let pass = 0; pass < 4; pass++) {
        const did = await fill(false);
        if (lastError) return report("error", lastError);
        if (!did) break;
        await sleep(1500);
      }
      // Wait until the resume upload is complete (the field shows the file name).
      badge("hunt: waiting for the resume upload…");
      if (resumeState() === "pending") await waitFor(() => resumeState() === "done", 15000, 1000);
      if (resumeState() === "pending" && !(await send("huntGate")).rateLimited) {
        // One more try: attach the file again.
        badge("hunt: resume upload is slow, attaching again…");
        const input = document.querySelector(RESUME_INPUT);
        if (input) delete input.dataset.edithUploaded;
        try { sessionStorage.removeItem(appKey()); } catch (e) {}
        await uploadResume();
        await waitFor(() => resumeState() === "done", 20000, 1000);
      }
      await sleep(1000);
      // The job site refused requests from this tab: the saved form is not reliable.
      if ((await send("huntGate")).rateLimited) return report("rate_limited", "the job site answered 429 (too many requests)");
      if (resumeState() === "pending") return report("needs_review", "resume upload did not complete");
      const missing = missingRequired();
      // A site with a CAPTCHA that you type (Keka): the form is ready, and the
      // tab stays open. You type the CAPTCHA and click the apply button.
      if (h.manual) {
        const rest = missing.filter((m) => !/captcha/i.test(m.label)).map((m) => m.label);
        await report("needs_review", "type the CAPTCHA and submit" + (rest.length ? ". Also empty: " + rest.join("; ") : ""), true);
        return watchManual("form filled. Type the CAPTCHA, check the form, then click the apply button. This tab stays open.");
      }
      // A question of yours can be an empty field or an unticked required box.
      const notValid = invalidFields();
      const yours = [...yourQuestions].filter((l) => missing.some((m) => m.label === l) || notValid.includes(l));
      if (yours.length) {
        await report("needs_review", "your answer is needed: " + yours.join("; "), true);
        return watchManual("answer the orange question(s), then click Submit. This tab stays open.");
      }
      if (missing.length) return report("needs_review", "empty: " + missing.map((m) => m.label).join("; "));
      const invalid = invalidFields();
      if (invalid.length) return report("needs_review", "invalid: " + invalid.slice(0, 5).join("; "));
      if (!submit) return report("filled", "submit is off");

      const btn = findButton(/^(submit|submit application|apply|send application)$/i);
      if (!btn) return report("needs_review", "no Submit button found");
      if (btn.disabled) return report("needs_review", "Submit button is disabled");
      if ((await send("huntGate")).rateLimited) return report("rate_limited", "the job site answered 429 (too many requests)");
      // Tell the background before the click. If the page reloads, the new
      // page then only checks for the confirmation and never submits again.
      await send("huntProgress", { msg: "hunt: clicked Submit, waiting for confirmation (45s)…", stage: "submit" });
      badge("hunt: clicked Submit, waiting for confirmation (45s)…");
      btn.click();
      const ok = await waitFor(isDone, 45000, 1000);
      if (ok) {
        await checkSubmitted();
        return report("submitted");
      }
      const errs = [...document.querySelectorAll('[role="alert"], [class*="error" i], [class*="failure" i]')]
        .filter(visible).map((e) => clean(textOf(e))).filter(Boolean);
      await report("submit_failed", errs.join(" | ").slice(0, 250) || "no confirmation after 45s (CAPTCHA or validation)");
      return watchManual();
    } catch (e) {
      return report("error", String(e.message || e));
    }
  }

  // Test hook for tests/run.js (Node). A browser never sets it.
  if (globalThis.__EDITH_TEST__) {
    globalThis.__EDITH_TEST__({ answerFor, pick, ruleValue, yourQuestions,
      setProfile: (p) => { profile = p; placesCache = null; }, setLocHome: (v) => { locHome = v; } });
    return;
  }

  // ---------- triggers ----------
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type !== "fill") return;
    reply({ ok: true });
    chrome.storage.local.get({ enabled: true }).then(({ enabled }) => {
      if (enabled) fill(true);
      else badge("extension is OFF", "warn");
    });
  });

  captureJob();
  chrome.storage.local.get({ autoFill: true, enabled: true }).then(async ({ autoFill, enabled }) => {
    if (!onAts || !enabled) return;
    if (window === window.top && /(ashbyhq\.com|greenhouse\.io|lever\.co|keka\.com)$/.test(host)) {
      const h = await send("huntTab");
      if (h.suppress) return; // this hunt tab loaded too many times: do nothing
      if (h.kept) return watchManual(); // left open for you after a failed submit
      if (h.hunt) return huntRun(h);
    }
    if (!autoFill) return;
    let timer;
    let passes = [];
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Guard against fill loops: at most 8 automatic passes in 30 seconds.
        const now = Date.now();
        passes = passes.filter((t) => now - t < 30000);
        if (passes.length >= 8) {
          badge("paused: the page keeps changing. Press Alt+Shift+F to fill.", "warn");
          return;
        }
        checkSubmitted();
        fill(false).then((did) => { if (did) passes.push(Date.now()); });
      }, 700);
    };
    const fromBadge = (m) => {
      const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return n && n.closest && n.closest("#edith-badge");
    };
    new MutationObserver((ms) => { if (!ms.every(fromBadge)) kick(); }).observe(document.documentElement, { childList: true, subtree: true });
    kick();
  });
})();
