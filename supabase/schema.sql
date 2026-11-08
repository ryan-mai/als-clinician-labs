-- ALS labs demo schema. Paste into Supabase SQL editor, then run seed.sql.
-- DEMO ONLY: policies below let the anon key read/write. Synthetic data only, no PHI.
-- To make it private: delete the "demo_*" policies, enable Supabase Auth, and
-- add policies like: using (auth.uid() = provider_id). See bottom of file.
create extension if not exists pgcrypto;

create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,            -- de-identified code, never a name/MRN
  age int check (age between 0 and 120),
  sex text check (sex in ('F','M','X')),
  synthetic boolean not null default true,
  label text,                           -- 'ALS-like' / 'control-like' for synthetic rows only
  alsfrs_r int check (alsfrs_r between 0 and 48),
  provider_id uuid,                     -- fill when Auth is on
  created_at timestamptz not null default now()
);

create table if not exists lab_results (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  analyte text not null,                -- nefl, creatinine, ck, albumin, uric_acid, bicarbonate, crp
  value double precision not null,
  collected_at date not null default current_date,
  created_at timestamptz not null default now()
);
alter table lab_results add column if not exists period text;   -- morning / afternoon / evening (device clock when the test was taken)
create index if not exists lab_results_patient on lab_results(patient_id, analyte, collected_at);

alter table patients enable row level security;
alter table lab_results enable row level security;
drop policy if exists demo_read_patients on patients;   create policy demo_read_patients on patients for select using (true);
drop policy if exists demo_write_patients on patients;  create policy demo_write_patients on patients for insert with check (synthetic = true);
drop policy if exists demo_read_labs on lab_results;    create policy demo_read_labs on lab_results for select using (true);
drop policy if exists demo_write_labs on lab_results;   create policy demo_write_labs on lab_results for insert with check (true);

-- Aggregate view for the registry dashboard (per-analyte summary across patients)
create or replace view analyte_summary as
select analyte, count(*) n, avg(value) mean, percentile_cont(0.5) within group (order by value) median
from lab_results group by analyte;

-- PRIVATE MODE (later): drop demo_* policies, then e.g.
--   create policy own_patients on patients for all using (provider_id = auth.uid()) with check (provider_id = auth.uid());
--   create policy own_labs on lab_results for all using (exists (select 1 from patients p where p.id = patient_id and p.provider_id = auth.uid()));
