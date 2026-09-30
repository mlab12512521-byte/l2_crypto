-- Phase 5: who changed a project since its last saved version (used by automatic versioning).

CREATE TABLE project_changes (
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  first_change_at timestamptz NOT NULL DEFAULT now(),
  last_change_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
