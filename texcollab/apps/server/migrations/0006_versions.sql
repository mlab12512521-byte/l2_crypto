-- Phase 7: project history (backed by one bare Git repository per project)
-- and optional external Git remotes.

CREATE TABLE versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  commit_sha   text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  kind         text NOT NULL CHECK (kind IN ('auto', 'named', 'restore', 'import', 'git-pull', 'initial')),
  label        text CHECK (char_length(label) <= 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  contributors uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX versions_project_idx ON versions (project_id, created_at DESC);

CREATE TABLE git_remotes (
  project_id       uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  url              text NOT NULL,
  branch           text NOT NULL DEFAULT 'main',
  username         text,
  -- Access token / password, AES-256-GCM encrypted with a key derived from APP_SECRET.
  secret_encrypted bytea,
  updated_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_push_at     timestamptz,
  last_pull_at     timestamptz,
  last_error       text
);
