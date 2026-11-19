"""Local helper for the EDITH extension (optional).

Answers unknown form questions through the Claude CLI (`claude -p`), caches
every short answer, and logs submitted applications.

The extension sends your profile with each request. The helper reads the
resume text from extension/resume.pdf (needs `pip install pypdf`, or the
`pdftotext` command).

Run: python3 helper/server.py   (listens on 127.0.0.1:8765)
"""
import csv
import json
import re
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESUME_PDF = ROOT / "extension" / "resume.pdf"
DATA_DIR = ROOT / "data"
CACHE_PATH = DATA_DIR / "answers.json"
LOG_PATH = DATA_DIR / "log.csv"
HOST, PORT = "127.0.0.1", 8765

FAST_MODEL = "haiku"     # short fields, selects, radios, checkboxes
WRITER_MODEL = "sonnet"  # long free-text answers
LONG_TYPES = {"textarea"}

cache_lock = threading.Lock()
log_lock = threading.Lock()
resume_lock = threading.Lock()
_resume = {}  # file name -> {"mtime", "text"}
RESUME_FILES = ("resume.pdf", "resume_ai.pdf", "resume_apm.pdf")  # default, and the optional one for AI and ML roles


def resume_text(name="resume.pdf"):
    """Text of one resume in extension/, read again when the file changes."""
    if name not in RESUME_FILES:
        name = "resume.pdf"
    path = ROOT / "extension" / name
    if not path.is_file():
        return resume_text() if name != "resume.pdf" else ""
    with resume_lock:
        mtime = path.stat().st_mtime
        hit = _resume.get(name)
        if hit and hit["mtime"] == mtime:
            return hit["text"]
        text = ""
        try:
            from pypdf import PdfReader
            text = "\n".join(page.extract_text() or "" for page in PdfReader(str(path)).pages)
        except ImportError:
            if shutil.which("pdftotext"):
                out = subprocess.run(["pdftotext", "-layout", str(path), "-"],
                                     capture_output=True, text=True, timeout=30)
                text = out.stdout
        except Exception as e:  # a damaged PDF: Claude then uses the profile only
            print(f"[warn] cannot read {name}:", e)
        _resume[name] = {"mtime": mtime, "text": text.strip()}
        return _resume[name]["text"]


def cache_key(q):
    label = re.sub(r"[^a-z0-9 ]", "", q["label"].lower())
    label = re.sub(r"\s+", " ", label).strip()
    opts = "|".join(sorted(o.lower().strip() for o in q.get("options") or []))
    return f"{q.get('type', 'text')}::{label}::{opts}"


def read_cache():
    if CACHE_PATH.is_file():
        return json.loads(CACHE_PATH.read_text())
    return {}


def write_cache(new_entries):
    with cache_lock:
        data = read_cache()
        data.update(new_entries)
        DATA_DIR.mkdir(exist_ok=True)
        CACHE_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))


SYSTEM_PROMPT = """You fill job application forms for one candidate. Answer as the candidate, truthfully, from the PROFILE and RESUME only.
Rules:
- If a question has options, the answer must be one of the options, copied exactly.
- Questions of type "checkbox-group" have several options: answer with the option or options that apply, copied exactly, separated by "; ".
- Checkbox questions: answer "true" or "false". Agree to privacy, consent and terms checkboxes only if agree_to_terms is "Yes".
- Yes/no questions: use the profile facts. Never invent degrees, employers, certifications, skills, or years of experience. If the profile and resume do not support "Yes", answer "No" or "".
- Work authorization: the candidate can work without sponsorship only in authorized_countries (if that list is empty: in the profile country). The candidate needs visa sponsorship everywhere else. Answer for the country that the question or the job names. If no country is clear, answer "".
- Short text fields: a short value only, no sentence.
- Long text fields: 60-120 words, first person, specific to the job and the resume, no clichés.
- Questions about experience, projects or achievements: lead with experience_focus from the profile when it has one, then add other resume items that fit the job. Use only facts from the profile and resume.
- Demographics (gender, pronouns, ethnicity, hispanic_or_latino, veteran_status, disability, transgender, sexual_orientation): use the profile value. If the profile value is empty, choose the "prefer not to say" or "decline" option.
- Willingness, availability and commitment questions (travel, team meet-ups, on-call, shifts, hours): use flexible_availability. Office and on-site questions: use comfortable_onsite. If that value is empty, answer "".
- Work mode preference (on-site, hybrid, remote): use work_mode_preference.
- "Do you have experience with X?" where X is not in the profile or resume, and "Do you have N+ years of experience?" where N is more than total_experience_years: answer "" (empty). The candidate answers these.
- Education: use university, degree, major, education_start and graduation_date. In a school list, choose the university or one of university_aliases. If the list does not have it, choose "Other". In a discipline list, choose the option closest to major or major_aliases.
- Location questions: use city, country, preferred_locations and open_to_locations.
- "Have you previously applied to <company>?": answer Yes only if previous_applications names that company (or its parent company).
- custom_answers holds the candidate's own answers to common questions. If a question asks the same thing, use that answer.
- Use today's date (given with the job) for questions about dates and durations.
- Preference or opinion questions (for example "Preferred team?"): give a short, reasonable answer that fits the resume. Do not leave them empty.
- An empty profile value is unknown. If a factual answer cannot be known, answer "" (empty string).
{extra}
PROFILE:
{profile}

RESUME:
{resume}
"""

ANSWER_SCHEMA = json.dumps({
    "type": "object",
    "properties": {"answers": {"type": "object", "additionalProperties": {"type": "string"}}},
    "required": ["answers"],
})


def ask_claude(model, questions, job, profile, instructions, resume):
    lines = []
    for q in questions:
        line = f'- id "{q["id"]}" [{q.get("type", "text")}] {q["label"]}'
        if q.get("options"):
            line += " | options: " + json.dumps(q["options"], ensure_ascii=False)
        lines.append(line)
    prompt = (
        f"Today's date: {datetime.now().date().isoformat()}\n"
        f"Job: {job.get('title', '')} at {job.get('company', '')}\n"
        f"URL: {job.get('url', '')}\n"
        f"Description:\n{(job.get('description') or '')[:4000]}\n\n"
        "Answer every question. Key the answers object by question id.\n"
        + "\n".join(lines)
    )
    extra = f"- Candidate's own instructions (follow them):\n{instructions.strip()}\n" if instructions.strip() else ""
    system = SYSTEM_PROMPT.format(
        extra=extra,
        profile=json.dumps(profile, indent=1, ensure_ascii=False),
        resume=resume[:12000] or "(no resume text: use the profile only)")
    cmd = [
        "claude", "-p", prompt,
        "--model", model,
        "--system-prompt", system,
        "--tools", "",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--no-session-persistence",
        "--output-format", "json",
        "--json-schema", ANSWER_SCHEMA,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=180, cwd=ROOT / "helper")
    if not out.stdout.strip():
        raise RuntimeError("claude CLI gave no output: " + out.stderr.strip()[:300])
    data = json.loads(out.stdout)
    if data.get("is_error"):
        raise RuntimeError(data.get("result") or out.stderr)
    return (data.get("structured_output") or json.loads(data["result"]))["answers"]


def snap_to_option(value, options):
    """Force an LLM answer onto one of the allowed options."""
    if not options or value == "":
        return value
    low = value.lower().strip()
    for o in options:
        if o.lower().strip() == low:
            return o
    for o in options:
        if low in o.lower() or o.lower() in low:
            return o
    return ""


PM_RULES = """This job is a product management role (Product Manager, APM, Product Owner). Write as a candidate for product work:
- Lead with users, problems, outcomes, metrics, prioritization, trade-offs and work across teams. Take the examples from the resume.
- Describe engineering work as product work that the candidate drove: discovery, launch criteria, adoption, measured results.
- Be honest about titles: the current title is in the profile. Do not claim a Product Manager title or years as a product manager that the resume does not show.
- "Why product management?": connect the candidate's product ownership in the current job with the wish to do it full-time."""


def answer_questions(questions, job, profile, instructions, resume_file="resume.pdf", track="sde"):
    if track == "pm":
        instructions = (PM_RULES + "\n" + (instructions or "")).strip()
    pre = "pm::" if track == "pm" else ""  # product roles keep their own saved answers
    cache = read_cache()
    answers, todo = {}, []
    for q in questions:
        key = pre + cache_key(q)
        if key in cache:
            answers[q["id"]] = cache[key]
        else:
            todo.append(q)

    short = [q for q in todo if q.get("type") not in LONG_TYPES]
    long_ = [q for q in todo if q.get("type") in LONG_TYPES]
    resume = resume_text(resume_file)
    batches = [(FAST_MODEL, short), (WRITER_MODEL, long_)]
    new_cache = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [(qs, pool.submit(ask_claude, m, qs, job, profile, instructions, resume)) for m, qs in batches if qs]
        for qs, fut in futures:
            got = fut.result()
            for q in qs:
                val = snap_to_option(str(got.get(q["id"], "")), q.get("options"))
                answers[q["id"]] = val
                # Long answers are job-specific, so only short ones go in the cache.
                if val != "" and q.get("type") not in LONG_TYPES:
                    new_cache[pre + cache_key(q)] = val
    if new_cache:
        write_cache(new_cache)
    return answers, len(todo)


def append_log(entry):
    with log_lock:
        DATA_DIR.mkdir(exist_ok=True)
        new = not LOG_PATH.is_file()
        with LOG_PATH.open("a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["time", "company", "title", "url", "status", "note"])
            w.writerow([datetime.now().isoformat(timespec="seconds"), entry.get("company", ""),
                        entry.get("title", ""), entry.get("url", ""), entry.get("status", ""),
                        entry.get("note", "")])


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _cors(self):
        # Lets a browser extension read the answer also when Chrome withholds
        # its site access. Web pages get no such header, so they stay blocked.
        origin = self.headers.get("Origin") or ""
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):  # the browser asks first, before a POST with JSON
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _allowed(self):
        # Only the extension (or a local tool without an Origin) may call the
        # helper. A web page cannot use it to run Claude with your profile.
        origin = self.headers.get("Origin")
        if origin and not origin.startswith("chrome-extension://"):
            return False
        # Blocks DNS rebinding: the Host must be this machine.
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def do_GET(self):
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        if self.path == "/health":
            return self._send(200, {"ok": True, "resume": RESUME_PDF.is_file(), "resume_text": bool(resume_text())})
        if self.path == "/applications":  # the application log, for the popup's Excel file
            rows = []
            if LOG_PATH.is_file():
                with log_lock, open(LOG_PATH, newline="", encoding="utf-8") as f:
                    rows = list(csv.DictReader(f))
            return self._send(200, {"rows": rows})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/answer":
                t0 = datetime.now()
                answers, asked = answer_questions(body.get("questions", []), body.get("job", {}),
                                                  body.get("profile", {}), body.get("instructions", ""),
                                                  str(body.get("resume_file") or "resume.pdf"),
                                                  str(body.get("track") or "sde"))
                ms = int((datetime.now() - t0).total_seconds() * 1000)
                print(f"[answer] {len(answers)} answers, {asked} from Claude, {ms} ms")
                return self._send(200, {"answers": answers})
            if self.path == "/log":
                append_log(body)
                return self._send(200, {"ok": True})
            self._send(404, {"error": "not found"})
        except Exception as e:
            print("[error]", e)
            self._send(500, {"error": str(e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    if not shutil.which("claude"):
        print("[warn] the claude CLI is not on PATH. Install Claude Code: https://claude.com/claude-code")
    if not RESUME_PDF.is_file():
        print(f"[warn] {RESUME_PDF} not found. Claude answers from the profile only.")
    elif not resume_text():
        print("[warn] cannot read text from resume.pdf. Install pypdf: pip install pypdf")
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        if e.errno in (48, 98):  # address already in use (macOS, Linux)
            print(f"The helper is already running on http://{HOST}:{PORT}. You do not need to start it again.")
            print(f"To restart it, stop the old one first:  lsof -ti tcp:{PORT} | xargs kill")
            raise SystemExit(0)
        raise
    print(f"EDITH helper on http://{HOST}:{PORT}")
    server.serve_forever()
