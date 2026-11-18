-- 001_init.sql — Shodh a Code schema.
-- Invariants enforced by the database (not by application memory):
--  * idempotency: UNIQUE (contest_id, author_id, idempotency_key) on submissions.
--  * one logical verdict per attempt: UNIQUE (submission_id, attempt_no);
--    verdict application is conditional on (status='running', worker_id) so a
--    stale worker can never overwrite a newer attempt's result.
--  * problem/test-suite versions are immutable rows; a submission pins
--    problem_version_id + test_suite_id, so editing a problem never changes
--    the meaning of a historical verdict.
--  * hidden test data lives only in test_cases; the API never selects
--    input/expected_output for participant-facing reads.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org_memberships (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('organizer', 'participant')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_memberships_user ON org_memberships (user_id);

CREATE TABLE contests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  penalty_per_wrong INT NOT NULL DEFAULT 20 CHECK (penalty_per_wrong >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  CHECK (closes_at > opens_at)
);
CREATE INDEX idx_contests_org ON contests (org_id);

CREATE TABLE contest_participants (
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contest_id, user_id)
);

CREATE TABLE problems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL DEFAULT '',
  time_limit_ms INT NOT NULL DEFAULT 2000 CHECK (time_limit_ms > 0),
  memory_mb INT NOT NULL DEFAULT 256 CHECK (memory_mb > 0),
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE problem_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  version INT NOT NULL CHECK (version >= 1),
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_id, version)
);
CREATE INDEX idx_pv_problem ON problem_versions (problem_id);
ALTER TABLE problems
  ADD CONSTRAINT fk_problems_current_version
  FOREIGN KEY (current_version_id) REFERENCES problem_versions (id);

CREATE TABLE test_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_version_id UUID NOT NULL REFERENCES problem_versions(id) ON DELETE CASCADE,
  version INT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_version_id, version)
);
CREATE INDEX idx_ts_pv ON test_suites (problem_version_id);

CREATE TABLE test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_suite_id UUID NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
  position INT NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  expected_output TEXT NOT NULL DEFAULT '',
  is_hidden BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (test_suite_id, position)
);
CREATE INDEX idx_tc_suite ON test_cases (test_suite_id);

CREATE TABLE submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  problem_version_id UUID NOT NULL REFERENCES problem_versions(id),
  test_suite_id UUID NOT NULL REFERENCES test_suites(id),
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'python',
  runtime_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  current_attempt_no INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contest_id, author_id, idempotency_key)
);
CREATE INDEX idx_sub_contest_author ON submissions (contest_id, author_id, created_at DESC);
CREATE INDEX idx_sub_status ON submissions (status, created_at);

CREATE TABLE attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  attempt_no INT NOT NULL CHECK (attempt_no >= 1),
  problem_version_id UUID NOT NULL REFERENCES problem_versions(id),
  test_suite_id UUID NOT NULL REFERENCES test_suites(id),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded')),
  verdict TEXT CHECK (
    verdict IS NULL OR verdict IN
    ('accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'judge_error')
  ),
  score INT NOT NULL DEFAULT 0 CHECK (score >= 0),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  worker_id TEXT,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, attempt_no)
);
CREATE INDEX idx_attempts_queue ON attempts (status, created_at) WHERE status = 'queued';
CREATE INDEX idx_attempts_submission ON attempts (submission_id, attempt_no);
CREATE INDEX idx_attempts_heartbeat ON attempts (status, heartbeat_at) WHERE status = 'running';
