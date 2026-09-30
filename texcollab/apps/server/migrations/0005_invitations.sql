-- Phase 6: invitations for people who do not have an account yet.
-- Claimed automatically when a user with this e-mail address signs in
-- (e.g. first LDAP login) or is created by an administrator.

CREATE TABLE project_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        text NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  UNIQUE (project_id, email)
);
CREATE INDEX project_invitations_email_idx ON project_invitations (email);
