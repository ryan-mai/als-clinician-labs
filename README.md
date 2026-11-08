# ALS Clinician Labs (research demo)
Providers submit lab results (NfL, creatinine, CK, ...); each is compared with research-cohort and generic reference data; a dashboard aggregates across patients. Synthetic data only.

## Run
    cd clinician_labs
    python -m http.server 8765      # open http://localhost:8765

## Phone session (mobile, `session.html`)
One guided check-in on a phone: a relaxed chat with a voice assistant, say ee / ah / oo, then fist and key-pinch with each hand. One camera + mic permission; each step starts by itself (voice onset, or hand found and still) and bad takes are retried in place. Camera video never leaves the phone, and neither does the sound for the vowel and hand steps; during the chat the patient's voice goes to ElevenLabs (this app saves neither the audio nor the words). The patient taps Share to send summary numbers.
- **Chat instead of a fixed passage.** The doctor types the questions they expect (Patients page, "Check-in conversation", stored per patient code in `data_store/conversation_plans.json`; suggested questions if none). An ElevenLabs agent asks them conversationally so it feels like talking to a person, not taking a test. Speaking rate = words the speech-to-text heard from the patient / time they were actually speaking, assistant turns excluded (`convo.js`, tests in `src/test_convo.js`). Conversational rate is not comparable with passage-reading rate, so read it against the patient's own earlier chats. Needs `ELEVENLABS_CHAT_AGENT_ID` (a second agent; setup and prompt in `elevenlabs/chat_agent_setup.md`). Without it, or if the chat fails to start, the check-in falls back to the standard passage.
- Speaking rate fallback (passage timing, `ddk.js`). Lip and jaw movement is measured only while the patient is speaking. Vowels: LPC formants -> vowel space area and centralization ratio (`vowel.js`); lip spread and jaw speed from face landmarks (`lipjaw.js`).
- Hands: camera closure/pinch -> a unitless score (`kgest.js`, saved as `grip_score_*` / `pinch_score_*`). The doctor report converts it to an *estimated* kg only by anchoring the first-week score to the nearest clinic dynamometer reading. Not force, not validated.
- Optional 1-minute walk uses the phone motion sensor (`gait.js`). Doctor view: `homepanel.js` (baseline vs latest, % of baseline, trend) in `compare.html`.
- Needs https or localhost for camera/mic and internet the first time (MediaPipe models). `session.html?demo=1` runs the whole flow on synthetic data with no camera (`&decline=0.7` simulates decline).
- Gemini does not take part in the check-in. It is used only for the doctor report: it summarises the findings for the neurosurgeon (`/api/report-summary`), reads uploaded results sheets (`/api/extract-labs`) and writes the monitoring bullets (`/api/summarize`); each falls back to built-in text without `GEMINI_API_KEY`.
- Set `LOCAL_ONLY=1` to ignore `DATABASE_URL` and use the local JSON file (in PowerShell `DATABASE_URL=` cannot be set empty, it deletes the variable and the `.env` value takes over).
- Not measurable on a phone, so clinic only: NfL, CK, genetics, spinal tap, muscle biopsy, true dynamometer force.

## Care team side (no accounts) and patient onboarding
BioHacks itself is the care team, so there is **no doctor sign-in or doctor onboarding**. Open the dashboard (`index.html`, `triage.html` "Patients", `compare.html`, `engine.html`) and use it. Records made by the care team (saved question lists, the audit log) are attributed to `care-team@biohacks`.
- **The symptom questionnaire lives on the patient's phone.** The first time a patient code opens `session.html` and has no record yet, the patient gets a short onboarding in the app: a sudden-onset check, how it started, muscles, speech/swallowing/breathing, anything else, background, what matters to them, the chat topics, and consent. The questions are the team's triage questions (`triage.js`, ported from `python/als_triage.py`) minus the exam-only finding (reflexes) that a patient cannot answer. The phone never shows the patient a tier or a diagnosis.
- **The server works out the tier** from the answers (`POST /api/patient/onboard`); whatever the phone sends as a tier is ignored. The patient's self-report is stored in `data_store/triage.json` and shown on the Patients page ("Symptom screen from the patient").
- **Sudden, stroke-like onset** is the one case the phone acts on: the check-in stops, the patient is told to get urgent help, and the care team sees an emergency flag (no consent needed to flag a safety problem). The doctor page shows it in red.
- **A new code** is one with no readings and no finished onboarding. Patients who already have readings (for example `ALEX-CASE`) skip it. `session.html?demo=1&onboard=1&patient=NEWCODE` shows the onboarding in demo mode without saving.
- **Audit log:** `data_store/audit.log` (one JSON line per patient onboarding, emergency flag, triage view and question-list save). Self-reports are in `data_store/triage.json`, interests and consent in `data_store/patient_onboarding.json` (git-ignored).
- **Protecting a shared site:** set `ACCESS_TOKEN` in `.env` before exposing the server (a tunnel, for example) and open the site once with `/k/YOUR_TOKEN` or `?key=YOUR_TOKEN`. That key is the only gate: anyone with it can open the dashboard, and the patient-facing API trusts a de-identified code.
- **What this is not:** a compliance claim. The JSON files are not a clinical-grade store and there is no rate limiting. For a real hospital deployment add the organisation's own single sign-on with enforced multi-factor, an encrypted database hosted where your privacy law requires (PHIPA in Ontario), per-patient access tokens, and a privacy impact assessment. `auth.js` still holds the small JSON store for screens and the audit log; its old Google sign-in helpers are no longer used.

## Teammate's Python (`python/`)
`python/als_triage.py` is the team's symptom triage, copied unchanged. `triage.js` is a line-for-line port so the same rules run in the browser and on the server; `src/test_triage.js` runs the Python and the port on 600 random answer sets and fails if tier, reasons or next steps ever differ (`PYTHON=path\to\python` to pick an interpreter). Not ported: `als_screener.py` (the biomarker module `als_triage.py` imports) and `reference.csv` (needed by `Project.py`, the tkinter nearest-average comparison) were not in the shared folder, so the combined impression on the Patients page (`triage.html`) uses this project's existing control-vs-ALS reference table instead, with a placeholder threshold of 2 markers.

## Alex Chen case record
`ALEX-CASE` is the fictional patient from the BioHacks 2026 hacker package (`BioHacks-2026-Hacker-Package-compressed.pdf`): CK 470, NfL 88 pg/mL, dynamometer grip right 14 / left 32 kg, 10 m walk 14.2 s, FVC 76% sitting / 61% supine, SNIP 52, ALSFRS-R 32. Case-file reference text is noted on each analyte.

## Supabase (optional)
Run `supabase/schema.sql` then `supabase/seed.sql` in the SQL editor; put URL + anon key in `supabase-config.js`. Empty config = browser storage.

## Regenerate reference data / tests
    ..\.venv\Scripts\python -I src\11_lab_reference.py
    node src\test_labs.js

NfL reference: Kim et al. plasma cohorts (`data/kim`, log2 NPQ units, not pg/mL). Routine ranges are generic adult ranges. See `../voice_gait_timeline/` for the earlier voice/gait/timeline project.


## Reference data
Grip-strength control range in `reference.js` comes from NHANES 2011-12 (`data/nhanes/`, summary in `grip_reference.json`): adults 40-79, weaker hand, 5th-95th percentile. Other rows are still the hand-entered NeuroMotion table; PRO-ACT and Answer ALS need registration, so they are not included.
