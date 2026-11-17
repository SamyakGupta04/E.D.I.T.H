// EDITH shared logic: config -> profile, and country / location matching.
// Loaded by the background service worker (importScripts) and before
// content.js in each page. A second injection keeps the first copy.
(() => {
  if (globalThis.EdithShared) return;

  // ---------- config -> flat profile ----------
  // config.json groups the fields in sections ("personal", "contact", ...).
  // The extension works with one flat object. "hunt" is not part of the profile.
  const LIST_KEYS = ["authorized_countries", "home_locations", "preferred_locations", "skills", "skill_keywords",
    "previous_applications", "degree_aliases", "major_aliases", "university_aliases", "ethnicity"];

  const toList = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [])
    .map((s) => String(s).trim()).filter(Boolean);

  function toProfile(cfg) {
    const p = {};
    for (const [k, v] of Object.entries(cfg || {})) {
      if (k === "hunt" || k.startsWith("_")) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(p, v);
      else p[k] = v;
    }
    for (const k of Object.keys(p)) if (k.startsWith("_")) delete p[k];
    for (const k of LIST_KEYS) if (k in p) p[k] = toList(p[k]);
    for (const [k, v] of Object.entries(p)) if (typeof v === "string") p[k] = v.trim();
    // Derived fields.
    p.full_name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ");
    p.phone_full = p.phone ? [p.phone_country_code, p.phone].filter(Boolean).join(" ") : "";
    p.graduation_year = p.graduation_year || String(p.graduation_date || "").slice(0, 4);
    p.custom_answers = Array.isArray(p.custom_answers) ? p.custom_answers : [];
    return p;
  }

  // Fields that EDITH needs before it can fill a form.
  const REQUIRED = [["first_name", "First name"], ["last_name", "Last name"], ["email", "Email"], ["phone", "Phone"], ["country", "Country"]];
  const missingRequired = (p) => REQUIRED.filter(([k]) => !p[k]).map(([, label]) => label);

  // ---------- countries ----------
  // Each country with the words that name it in a job location or a question.
  // "us" is never matched in lower case ("tell us about…"): only "US".
  const COUNTRIES = {
    "india": ["india", "bharat"],
    "united states": ["usa", "u.s", "u.s.a", "united states of america", "america"],
    "united kingdom": ["uk", "u.k", "great britain", "britain", "england", "scotland", "wales", "london"],
    "canada": ["toronto", "vancouver", "montreal"],
    "european union": ["europe", "eu", "eea", "schengen"],
    "germany": ["berlin", "munich"], "france": ["paris"], "spain": ["madrid", "barcelona"], "portugal": ["lisbon"],
    "italy": ["milan", "rome"], "netherlands": ["amsterdam"], "ireland": ["dublin"], "poland": ["warsaw", "krakow"],
    "sweden": ["stockholm"], "denmark": ["copenhagen"], "norway": ["oslo"], "finland": ["helsinki"],
    "switzerland": ["zurich", "geneva"], "austria": ["vienna"], "belgium": ["brussels"],
    "australia": ["sydney", "melbourne"], "new zealand": ["auckland"], "singapore": [], "japan": ["tokyo"],
    "south korea": ["korea", "seoul"], "china": ["beijing", "shanghai"], "hong kong": [],
    "united arab emirates": ["uae", "emirates", "dubai", "abu dhabi"], "saudi arabia": ["saudi", "riyadh"],
    "israel": ["tel aviv"], "brazil": ["sao paulo"], "mexico": ["mexico city"], "argentina": ["buenos aires"],
    "colombia": ["bogota"], "turkey": ["istanbul"], "egypt": ["cairo"], "nigeria": ["lagos"], "kenya": ["nairobi"],
    "south africa": ["cape town", "johannesburg"], "philippines": ["manila"], "indonesia": ["jakarta"],
    "vietnam": [], "thailand": ["bangkok"], "malaysia": ["kuala lumpur"], "pakistan": [], "bangladesh": [],
    "sri lanka": [], "nepal": [],
  };
  // ISO codes that job boards send instead of a country name.
  const ISO = { IN: "india", US: "united states", GB: "united kingdom", UK: "united kingdom", CA: "canada",
    DE: "germany", FR: "france", ES: "spain", PT: "portugal", IT: "italy", NL: "netherlands", IE: "ireland",
    PL: "poland", SE: "sweden", DK: "denmark", NO: "norway", FI: "finland", CH: "switzerland", AT: "austria",
    BE: "belgium", AU: "australia", NZ: "new zealand", SG: "singapore", JP: "japan", KR: "south korea",
    CN: "china", HK: "hong kong", AE: "united arab emirates", SA: "saudi arabia", IL: "israel", BR: "brazil",
    MX: "mexico", AR: "argentina", CO: "colombia", TR: "turkey", EG: "egypt", NG: "nigeria", KE: "kenya",
    ZA: "south africa", PH: "philippines", ID: "indonesia", VN: "vietnam", TH: "thailand", MY: "malaysia",
    PK: "pakistan", BD: "bangladesh", LK: "sri lanka", NP: "nepal" };

  const lc = (s) => String(s || "").toLowerCase().trim();
  // The country key and all its words. An unknown name gives only itself.
  function countryWords(name) {
    const n = lc(ISO[String(name || "").trim().toUpperCase()] || name);
    if (!n) return { key: "", words: [] };
    for (const [key, words] of Object.entries(COUNTRIES)) {
      if (key === n || words.includes(n)) return { key, words: [key, ...words] };
    }
    return { key: n, words: [n] };
  }
  const isUS = (name) => countryWords(name).key === "united states";

  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reCache = new Map();
  function wordsRe(words) {
    const k = words.join("|");
    if (!reCache.has(k)) {
      reCache.set(k, words.length ? new RegExp("(^|[^a-z])(" + words.map(esc).join("|") + ")($|[^a-z])") : null);
    }
    return reCache.get(k);
  }
  const hasAny = (text, words) => { const re = wordsRe(words); return !!re && re.test(lc(text)); };
  const ALL_WORDS = Object.entries(COUNTRIES).flatMap(([k, w]) => [k, ...w]);

  // A set of places: country words plus cities. "us" marks the United States.
  function placeSet(countries, cities) {
    const words = new Set(), keys = new Set();
    for (const c of countries) { const { key, words: w } = countryWords(c); if (key) keys.add(key); w.forEach((x) => words.add(x)); }
    for (const c of cities) if (lc(c)) words.add(lc(c));
    return { words: [...words], keys, us: keys.has("united states") };
  }

  // Places of the candidate.
  // auth: where the candidate can work without sponsorship.
  // home: where the candidate lives (for "Are you based in …?").
  function places(p) {
    const cities = toList(p.home_locations);
    const auth = toList(p.authorized_countries);
    return {
      auth: placeSet(auth.length ? auth : [p.country], cities),
      home: placeSet([p.country], [...cities, p.city || ""]),
      cities: cities.map(lc),
    };
  }

  // "home": the text names a place of the set. "foreign": it names another
  // country. "none": no country.
  function namedCountry(text, set) {
    const t = String(text || "");
    if (hasAny(t, set.words) || (set.us && /\bUS\b/.test(t))) return "home";
    const others = ALL_WORDS.filter((w) => !set.words.includes(w));
    if (hasAny(t, others) || (!set.us && /\bUS\b/.test(t))) return "foreign";
    return "none";
  }

  // Job location against the allowed locations of a hunt.
  // state "ok": the location matches the list. "bad": it does not.
  // "unknown": no location, or no list. home: the candidate can work there
  // without sponsorship, so the work-permit answers are true.
  function judgeLocation(loc, allowed, country, pl) {
    const raw = String(loc || "");
    loc = lc(loc);
    const c = country ? countryWords(country).key : "";
    const text = loc + (c ? "; " + c : "");
    const home = !!pl && (hasAny(text, pl.auth.words) || (pl.auth.us && /\bUS\b/.test(raw)));
    let terms = toList(allowed).map(lc);
    if (!text || !terms.length) return { state: "unknown", home, loc: text };
    const wantsRemote = terms.includes("remote");
    terms = terms.filter((t) => t !== "remote");
    let usOk = false;
    const expanded = new Set();
    for (const t of terms) {
      const { key, words } = countryWords(t);
      words.forEach((w) => expanded.add(w));
      if (key === "united states") usOk = true;
      // Your country in the list also allows the cities of home_locations.
      if (pl && pl.home.keys.has(key)) pl.cities.forEach((w) => expanded.add(w));
    }
    if (hasAny(text, [...expanded]) || (usOk && /\bus\b/.test(text))) return { state: "ok", home, loc: text };
    // "Remote" alone, or remote with a worldwide scope, is allowed.
    // "Remote - US", or remote with a foreign country on record, is not.
    if (wantsRemote && /remote|anywhere|global|worldwide/.test(loc) && !c) {
      const rest = loc.replace(/remote|anywhere|global|worldwide|[^a-z]/g, "");
      if (!rest || /apac|asia|global|worldwide|anywhere/.test(loc)) return { state: "ok", home: false, loc: text };
    }
    return { state: "bad", home, loc: text };
  }

  globalThis.EdithShared = { toProfile, toList, missingRequired, places, namedCountry, judgeLocation, countryWords, isUS, hasAny };
})();
