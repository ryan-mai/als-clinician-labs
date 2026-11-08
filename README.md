# ALS Clinician Labs (research demo)
Providers submit lab results (NfL, creatinine, CK, ...); each is compared with research-cohort and generic reference data; a dashboard aggregates across patients. Synthetic data only.

## Run
    cd clinician_labs
    python -m http.server 8765      # open http://localhost:8765

## Patient page
`patient.html` is a camera movement check with two tests and a side choice (right/left):
- **Hand:** open and close the fist for 10 s (MediaPipe Hands).
- **Foot:** seated toe-lift, side-on view, ankle angle (MediaPipe Pose, lite model).

MediaPipe loads from jsDelivr/Google the first time, so it needs internet; the camera needs https or localhost. Each test saves rate, range, speed and decline as e.g. `grip_amp_r` or `foot_speed_l`, with a time-of-day period (morning/afternoon/evening from the device clock), to an existing patient code. The clinician report shows the sessions, right-vs-left ratios and morning-vs-later change. These are movement proxies, not force, have no reference range, and are unvalidated. Logic in `grip.js`, tests in `src/test_grip.js`.

## Alex Chen case record
`ALEX-CASE` is the fictional patient from the BioHacks 2026 hacker package (`BioHacks-2026-Hacker-Package-compressed.pdf`): CK 470, NfL 88 pg/mL, dynamometer grip right 14 / left 32 kg, 10 m walk 14.2 s, FVC 76% sitting / 61% supine, SNIP 52, ALSFRS-R 32. Case-file reference text is noted on each analyte.

## Supabase (optional)
Run `supabase/schema.sql` then `supabase/seed.sql` in the SQL editor; put URL + anon key in `supabase-config.js`. Empty config = browser storage.

## Regenerate reference data / tests
    ..\.venv\Scripts\python -I src\11_lab_reference.py
    node src\test_labs.js

NfL reference: Kim et al. plasma cohorts (`data/kim`, log2 NPQ units, not pg/mL). Routine ranges are generic adult ranges. See `../voice_gait_timeline/` for the earlier voice/gait/timeline project.
