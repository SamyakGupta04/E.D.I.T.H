<p align="center"><img src="extension/icons/icon128.png" width="96" alt="EDITH"></p>

<h1 align="center">EDITH</h1>

<p align="center"><b>E</b>very <b>D</b>etail <b>I</b>n <b>T</b>he <b>H</b>iring form, filled for you.<br>
A Chrome extension that fills job applications from your own profile and resume.</p>

---

EDITH runs in your own Chrome, with your own logins. You write your answers once (name, contact, education, work permit, salary, common Yes/No questions). EDITH then fills application forms on Workday, Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS, and most other sites, and it uploads your `resume.pdf`.

An optional local helper sends the questions that EDITH does not know to the [Claude Code](https://claude.com/claude-code) CLI. A "job hunt" mode can find matching jobs on Ashby, Greenhouse, Lever and Keka and apply to them.

## Features

- **One profile, every portal.** Text fields, dropdowns, radio buttons, checkboxes, searchable lists, date pickers, and Ashby Yes/No buttons.
- **Settings page** to edit your profile, or a plain `config.json` file.
- **Custom answers** for the questions that you see often ("What percentage of your time do you enjoy coding?").
- **Safe defaults.** Work-permit questions get a true answer for the country that the question names. Empty self-identification fields select "Prefer not to say". Options must really match ("Male" never selects "Female", your university never becomes a similar one).
- **Claude for the rest** (optional). Short answers use Haiku, long answers use Sonnet. Short answers go into a local cache, so a repeated question costs nothing.
- **Visual review.** Green outline: Claude wrote this answer. Orange outline: a required field is still empty.
- **Job hunt** (optional). Google search plus the public job lists of each company, with a location filter, a title filter, rate-limit handling, and a log.

## How it works

```
                    extension/config.json  or  Settings page
                                   │
                                   ▼
 Job page ──► content script ──► built-in answers + your profile ──► form filled
                    │                                                     ▲
                    │ unknown questions                                   │
                    ▼                                                     │
              helper (127.0.0.1:8765) ──► claude -p ──► answers ──────────┘
                    │
                    └── data/answers.json (cache), data/log.csv (submitted jobs)
```

## Requirements

- Google Chrome (or another Chromium browser).
- Optional, for unknown questions: Python 3.9+, the [Claude Code CLI](https://claude.com/claude-code) logged in (`claude` on your PATH), and `pip install pypdf`.

## Setup

1. **Get the code.**
   ```
   git clone https://github.com/SamyakGupta04/E.D.I.T.H.git
   cd E.D.I.T.H
   ```
2. **Add your resume.** Copy your resume to `extension/resume.pdf`. The name must be exactly `resume.pdf`. Job sites receive it as `First_Last_Resume.pdf`.
   Optional: add `extension/resume_ai.pdf` for AI and machine-learning jobs, and `extension/resume_apm.pdf` for product-management jobs. EDITH selects the resume from the job title. If a file is absent, EDITH uses `resume.pdf`.
3. **Add your profile.** Use one of the two methods:
   - Copy `extension/config.example.json` to `extension/config.json` and replace the example values.
   - Or skip the file and fill the Settings page after step 4.
4. **Load the extension.** Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder. On the first install, the Settings page opens if your profile is incomplete.
5. **Optional: start the Claude helper.**
   ```
   pip install -r helper/requirements.txt
   python3 helper/server.py
   ```
6. Log in to each job portal in Chrome as usual. Workday needs a separate account for each company.

Both `extension/config.json` and `extension/resume.pdf` are in `.gitignore`. They stay on your computer.

### Where your profile lives

EDITH keeps the profile in Chrome storage. It reads `extension/config.json` each time the extension starts. When the file changed since the last import, the file replaces the stored profile. So:

- Edit in **Settings** and click **Save**: the change applies at once.
- Edit **config.json**: reload the extension at `chrome://extensions` (or click **Reload config.json** in Settings).
- **Export config.json** in Settings downloads your current profile as a file.

## Configuration

`config.json` has these sections. Every field is optional except the ones marked `*`. An empty field is "unknown": EDITH does not guess it. The field goes to Claude, or stays empty for you (orange outline).

| Section | Fields |
|---|---|
| `personal` | `first_name`*, `last_name`*, `preferred_name`, `pronouns`, `date_of_birth` |
| `contact` | `email`*, `phone`* (without country code), `phone_country_code`, `linkedin`, `github`, `website` |
| `location` | `address_line1`, `city`, `state`, `postal_code`, `country`*, `nationality`, `authorized_countries`, `home_locations`, `preferred_locations`, `open_to_locations`, `willing_to_relocate` |
| `work` | `current_title`, `current_company`, `current_start`, `total_experience_years`, `notice_period_days`, `current_salary`, `expected_salary`, `work_mode_preference` (On-site / Hybrid / Remote), `skills`, `skill_keywords`, `summary`, `experience_focus`, `previous_applications` |
| `education` | `university`, `university_short`, `university_aliases`, `degree`, `degree_aliases`, `major`, `major_aliases`, `education_level`, `education_start`, `graduation_date`, `gpa`, `currently_student` |
| `questions` | Yes/No: `over_18`, `flexible_availability`, `comfortable_onsite`, `previously_worked_here`, `relatives_working_here`, `non_compete`, `criminal_record`, `government_official`, `background_check_consent`, `english_fluent`, `sms_consent`, `were_referred`, `agree_to_terms`. Text: `how_did_you_hear` |
| `demographics` | `gender`, `ethnicity`, `hispanic_or_latino`, `veteran_status`, `disability`, `transgender`, `sexual_orientation`. Empty: "Prefer not to say". |
| `writing` | `cover_letter_template`, `claude_instructions` |
| `pm` | Used for product-management jobs only: `pm_summary`, `pm_experience_focus`, `pm_cover_letter_template`, `pm_claude_instructions` |
| `custom_answers` | A list of `{ "question": "...", "answer": "..." }` |
| `hunt` | `roles`, `locations`, `exclude_titles`, `seed_ashby`, `seed_greenhouse`, `seed_lever`, `seed_keka` |

Notes:

- **Dates** use `YYYY-MM` (`education_start`, `graduation_date`, `current_start`) and `YYYY-MM-DD` (`date_of_birth`).
- **Lists** are JSON arrays. A comma-separated string also works.
- **Work permit.** `authorized_countries` lists the countries where you can work without sponsorship. Empty means your `country` only. For a question that names a country, EDITH answers for that country. For a question with no country, EDITH answers only when the job is in one of your countries.
- **`home_locations`** are cities in your country. They let EDITH see that "Waterloo, ON" is in Canada.
- **Aliases.** School and discipline lists use different names. EDITH selects an option only when it holds all main words of one of your names. For a school, it can also select "Other" and then type `university_short`.
- **`cover_letter_template`** fills "Why do you want to join?" style questions. Placeholders: `{role}`, `{company}`, `{summary}`, `{experience_focus}`, `{name}`, `{first_name}`, `{current_title}`, `{current_company}`, `{years}`. With no template and no summary, Claude writes these answers.
- **`custom_answers`.** A question is a phrase (every word must be in the form label) or a `/regular expression/`. Custom answers win over the built-in answers.
- **`claude_instructions`** adds your own rules to the Claude prompt, for example `Give salaries in EUR.`

## Use

1. Open a job application. On supported portals EDITH fills the form by itself. On other sites, press `Alt+Shift+F` or click **Fill this tab** in the popup.
2. Check the form:
   - **Green outline:** Claude wrote this answer. Read it.
   - **Orange outline:** a required field is still empty. Fill it.
3. Click Submit. EDITH detects the confirmation page. With the helper running, it adds a row to `data/log.csv`.

On Workday, choose "Autofill with Resume" when it is offered. Workday then fills the work-experience and education sections from your PDF.

Popup switches:

- **Fill automatically on job portals:** on by default. Portals: Workday, Amazon, Google, Microsoft, Eightfold, Greenhouse, Lever, SmartRecruiters, iCIMS, SuccessFactors, Oracle, Taleo, Ashby, Workable, LinkedIn jobs.
- **Click "Next" when a page is complete:** off by default.
- **Click "Submit" when complete:** off by default. Turn it on only after the answers look correct on a few applications.
- **Ask Claude for unknown questions:** needs the helper.

## Job hunt (optional)

The hunt finds jobs on Ashby, Greenhouse, Lever and Keka and applies to each one. Keka forms end with a CAPTCHA: EDITH fills the form and keeps the tab open, and you type the CAPTCHA and submit.

**Download Excel** in the popup saves the company, position and job link of every application.

1. One time: open `chrome://extensions` > EDITH > Details > **Site access**, and select **On all sites**. With "On click", Chrome does not let EDITH work in the job tabs.
2. Open a new tab and open the popup. Make sure the switch at the top is ON.
3. Set the roles (one per line), the locations, and the skip words. **Use Settings defaults** copies them from Settings > Job hunt.
4. Click **Start hunt**.

The hunt first reads the public job lists of the companies that it knows (your `seed_*` lists, and companies from earlier hunts). Then it runs this Google search for each role:

```
(site:jobs.ashbyhq.com OR site:job-boards.greenhouse.io OR …) "Software Engineer" ("Canada" OR "Remote")
```

Each company that Google finds gives all its matching jobs. Each job opens in a background tab. The tab checks the location, fills the form, attaches the resume, and clicks Submit if **Submit each application automatically** is on.

| Status | Meaning | Tab |
|---|---|---|
| submitted | the site showed the confirmation | closed |
| skipped_location | the job location is not in your list | closed |
| closed / no_form | job closed, or no form in 25 s | closed |
| rate_limited | the site answered 429. The job runs again later (3 tries) | closed |
| filled | form complete, submit is off | left open |
| needs_review | a required field is empty or invalid, or a question needs you | left open |
| submit_failed | no confirmation 45 s after the Submit click | left open |
| timeout / error | no result in 240 s, or the page reloaded more than 3 times | left open |

Safety limits:

- Every job opens once. The history records a job before its tab opens. **Clear history** resets it.
- One Submit click for each job. A page that reloads after the click is only checked for the confirmation.
- Work-permit questions get an answer only when the job is in a country where you can work.
- A question about experience that your profile does not show ("5+ years of Kubernetes?") is never answered automatically. The tab stays open for you.
- At most 4 fill passes for each form. After 10 tabs need review, the hunt stops.
- If Google shows a CAPTCHA, the tab comes to the front. Solve it within 3 minutes.
- Switch EDITH OFF to stop everything.

## Privacy

- Your profile stays in Chrome storage and in `extension/config.json` on your computer.
- With the helper on, the profile and the resume text go to Claude through your own Claude Code login. Nothing else leaves your computer, except the forms that you (or EDITH) submit.
- The helper listens only on `127.0.0.1`, and it refuses requests from web pages.

## Files

| Path | Purpose |
|---|---|
| `extension/` | The Chrome extension (load this folder) |
| `extension/config.example.json` | Example profile with fictional data |
| `extension/config.json` | Your profile (git-ignored) |
| `extension/resume.pdf` | Your resume (git-ignored). Optional: `resume_ai.pdf`, `resume_apm.pdf` |
| `extension/xlsx.js` | Excel export of the application log |
| `extension/content.js` | Finds and fills form fields |
| `extension/background.js` | Profile, resume, helper relay, job hunt |
| `extension/shared.js` | Profile and location logic for both scripts |
| `extension/options.*`, `schema.js` | Settings page |
| `helper/server.py` | Optional Claude helper |
| `data/` | Answer cache and application log (git-ignored, made by the helper) |
| `tests/run.js` | Unit tests: `node tests/run.js` |

The answer cache (`data/answers.json`) keys answers by question text. After a large profile change, delete it, or edit single answers in it.

## Development

```
node tests/run.js          # answer rules and location logic
python3 -m py_compile helper/server.py
```

After a code change, click the reload icon of EDITH at `chrome://extensions` and reload the job tab.

## Disclaimer

You are responsible for every application that EDITH submits for you. Check the answers before you turn on automatic submit. Some job sites do not allow automated submissions in their terms of use. Use EDITH at your own risk.

## License

[MIT](LICENSE)
