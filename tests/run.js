// Unit tests for the answer rules and the location logic. Run: node tests/run.js
// No browser: content.js runs with small stubs, and exposes its rules through
// the __EDITH_TEST__ hook.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ext = path.join(__dirname, "..", "extension");
const ctx = {
  console, URL, Date, Math, JSON, RegExp, Symbol, Set, Map, WeakSet, Promise, Number, String, Array, Object,
  location: { hostname: "jobs.ashbyhq.com", pathname: "/examplecorp/123/application", href: "https://jobs.ashbyhq.com/examplecorp/123/application" },
  document: { title: "Backend Engineer @ Example Corp", querySelector: () => null, querySelectorAll: () => [] },
  chrome: { runtime: {}, storage: {} },
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ext, "shared.js"), "utf8"), ctx);
let T;
ctx.__EDITH_TEST__ = (api) => { T = api; };
vm.runInContext(fs.readFileSync(path.join(ext, "content.js"), "utf8"), ctx);
const S = ctx.EdithShared;

const example = JSON.parse(fs.readFileSync(path.join(ext, "config.example.json"), "utf8"));
const profile = S.toProfile(example);
T.setProfile(profile);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error("FAIL", name, "\n ", e.message); process.exitCode = 1; }
}
const ans = (label, kind = "radio", extra = {}) => {
  const it = { label, kind, type: kind === "text" ? "text" : kind, ...extra };
  const v = T.answerFor(it);
  return { v: v === undefined ? undefined : v === null ? null : [...v], must: it.must };
};
const first = (label, kind) => { const r = ans(label, kind); return r.v && r.v[0]; };
// The option that apply() would choose: first candidate that matches and passes "must".
const choose = (label, options, kind = "radio") => {
  const r = ans(label, kind, { options });
  if (!r.v) return r.v;
  for (const c of r.v) {
    const i = T.pick(options, c);
    if (i !== -1 && (!r.must || r.must.test(options[i]))) return options[i];
  }
  return "(none)";
};

// ---------- profile ----------
test("toProfile flattens sections and derives fields", () => {
  assert.strictEqual(profile.full_name, "Jordan Lee");
  assert.strictEqual(profile.phone_full, "+1 4165550123");
  assert.strictEqual(profile.graduation_year, "2022");
  assert.ok(!("hunt" in profile) && !("roles" in profile));
  assert.deepStrictEqual([...S.missingRequired(profile)], []);
  assert.deepStrictEqual([...S.missingRequired(S.toProfile({}))], ["First name", "Last name", "Email", "Phone", "Country"]);
});
test("list fields accept a comma string", () => {
  assert.deepStrictEqual([...S.toProfile({ work: { skills: "Go, Rust" } }).skills], ["Go", "Rust"]);
});

// ---------- built-in answers ----------
test("full name", () => assert.strictEqual(first("Full name", "text"), "Jordan Lee"));
test("school picks your school, never a similar one", () => {
  assert.strictEqual(choose("School", ["University of Waterloo", "University of Toronto", "Other"], "select"), "University of Toronto");
  assert.strictEqual(choose("School", ["University of Waterloo", "Toronto Metropolitan University", "Other"], "select"), "Other");
});
test("discipline", () => assert.strictEqual(choose("Discipline", ["Accounting", "Computer Science", "Biology"], "select"), "Computer Science"));
test("education months and years", () => {
  assert.strictEqual(first("Start date month", "select"), "September");
  assert.strictEqual(first("End date year", "select"), "2022");
});
test("work permit: own country Yes, other country No", () => {
  assert.deepStrictEqual(ans("Are you legally authorized to work in Canada?").v, ["Yes"]);
  assert.deepStrictEqual(ans("Are you legally authorized to work in the United States?").v, ["No"]);
  assert.deepStrictEqual(ans("Will you now or in the future require sponsorship to work in the US?").v, ["Yes"]);
  assert.deepStrictEqual(ans("Will you require visa sponsorship?").v, ["No"]);
});
test("no country named and a job abroad: leave empty", () => {
  T.setLocHome(false);
  assert.strictEqual(ans("Will you require visa sponsorship?").v, null);
  T.setLocHome(true);
});
test("'tell us' does not count as the US", () => {
  assert.notDeepStrictEqual(ans("Tell us why you want to work here", "text").v, ["No"]);
});
test("based in", () => {
  assert.deepStrictEqual(ans("Are you currently based in Canada?").v, ["Yes"]);
  assert.deepStrictEqual(ans("Are you currently based in the UK?").v, ["No"]);
});
test("demographics: empty means decline", () => {
  assert.strictEqual(choose("Gender", ["Male", "Female", "Decline to self-identify"]), "Decline to self-identify");
  assert.strictEqual(choose("Veteran status", ["I am a protected veteran", "I am not a protected veteran", "I don't wish to answer"]), "I don't wish to answer");
});
test("gender Male never picks Female", () => {
  T.setProfile({ ...profile, gender: "Male" });
  assert.strictEqual(choose("Gender", ["Female", "Male", "Decline"]), "Male");
  T.setProfile({ ...profile, gender: "Female" });
  assert.strictEqual(choose("Gender", ["Male", "Female", "Decline"]), "Female");
  T.setProfile(profile);
});
test("disability No picks the No option", () => {
  T.setProfile({ ...profile, disability: "No" });
  assert.strictEqual(choose("Disability status", ["Yes, I have a disability", "No, I do not have a disability", "I do not want to answer"]),
    "No, I do not have a disability");
  T.setProfile(profile);
});
test("years of experience picks the right range", () => {
  assert.strictEqual(choose("How many years of experience do you have?", ["0-1 years", "1-3 years", "3-5 years", "5+ years"], "select"), "1-3 years");
});
test("N+ years: Yes up to your years, else ask you", () => {
  assert.deepStrictEqual(ans("Do you have 2+ years of experience with Python?").v, ["Yes"]);
  assert.strictEqual(ans("Do you have 7+ years of experience?").v, null);
});
test("skills", () => {
  assert.deepStrictEqual(ans("Do you have experience with PostgreSQL?").v, ["Yes"]);
  assert.strictEqual(ans("Do you have experience with Kubernetes?").v, null);
});
test("work mode follows the profile", () => assert.strictEqual(choose("Preferred work arrangement", ["On-site", "Hybrid", "Remote"]), "Hybrid"));
test("notice period", () => assert.strictEqual(first("Notice period", "text"), "30 days"));
test("salary", () => assert.strictEqual(first("Expected salary", "text"), "115,000 CAD"));
test("custom answers: phrase and regex", () => {
  assert.strictEqual(first("What percentage of your time do you enjoy coding?", "text"), "70%");
  assert.strictEqual(first("What is your favorite programming language?", "text"), "Python");
});
test("cover letter uses the template", () => {
  const t = first("Why do you want to join us?", "textarea");
  assert.ok(t.startsWith("I am applying for the Backend Engineer role at Example Corp."), t);
});
test("empty Yes/No field: no built-in answer", () => {
  T.setProfile({ ...profile, criminal_record: "" });
  assert.strictEqual(ans("Have you ever been convicted of a crime in the last 7 years?").v, undefined);
  T.setProfile(profile);
});
test("previously applied", () => {
  assert.deepStrictEqual(ans("Have you previously applied to Example Corp?").v, ["No"]);
  T.setProfile({ ...profile, previous_applications: ["Example Corp, 2024"] });
  assert.deepStrictEqual(ans("Have you previously applied to Example Corp?").v, ["Yes"]);
  T.setProfile(profile);
});
test("profile rules", () => {
  assert.strictEqual(T.ruleValue("Email"), "jordan.lee@example.com");
  assert.strictEqual(T.ruleValue("Phone"), "+1 4165550123"); // Ashby: full number
  assert.strictEqual(T.ruleValue("GPA"), "3.6");
  assert.strictEqual(T.ruleValue("Postal code"), null);     // empty: left for you
});

// ---------- hunt locations ----------
const pl = S.places(profile);
test("job location: your country and its cities", () => {
  assert.strictEqual(S.judgeLocation("Toronto, ON", ["Canada"], "", pl).state, "ok");
  assert.strictEqual(S.judgeLocation("Waterloo", ["Canada"], "", pl).home, true);
  assert.strictEqual(S.judgeLocation("London, UK", ["Canada", "Remote"], "", pl).state, "bad");
});
test("job location: remote", () => {
  assert.strictEqual(S.judgeLocation("Remote", ["Remote"], "", pl).state, "ok");
  assert.strictEqual(S.judgeLocation("Remote - US", ["Canada", "Remote"], "", pl).state, "bad");
  assert.strictEqual(S.judgeLocation("Remote", ["Remote"], "US", pl).state, "bad");
});
test("ISO country codes", () => {
  assert.strictEqual(S.judgeLocation("Office", ["Canada"], "CA", pl).state, "ok");
  assert.strictEqual(S.judgeLocation("Office", ["Canada"], "IN", pl).state, "bad");
});
test("a US candidate", () => {
  const us = S.places(S.toProfile({ location: { country: "United States", home_locations: ["New York", "Austin"] } }));
  assert.strictEqual(S.namedCountry("Are you authorized to work in the US?", us.auth), "home");
  assert.strictEqual(S.namedCountry("Tell us about yourself", us.auth), "none");
  assert.strictEqual(S.judgeLocation("Austin, TX", ["United States"], "", us).state, "ok");
  assert.strictEqual(S.judgeLocation("Remote - US", ["United States"], "", us).state, "ok");
});

console.log(`${passed} tests passed${process.exitCode ? ", some failed" : ""}`);
