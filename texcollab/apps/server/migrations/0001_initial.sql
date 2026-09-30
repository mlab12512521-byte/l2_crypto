-- Phase 1: identity, sessions, settings, audit log.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             citext NOT NULL UNIQUE,
  email                citext UNIQUE,
  display_name         text NOT NULL,
  auth_source          text NOT NULL CHECK (auth_source IN ('local', 'ldap')),
  password_hash        text,
  ldap_dn              text,
  is_admin             boolean NOT NULL DEFAULT false,
  is_disabled          boolean NOT NULL DEFAULT false,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz,
  -- Local accounts must have a password hash; LDAP accounts must not.
  CONSTRAINT users_password_matches_source CHECK (
    (auth_source = 'local' AND password_hash IS NOT NULL)
    OR (auth_source = 'ldap' AND password_hash IS NULL)
  )
);

CREATE TABLE sessions (
  -- SHA-256 of the random token held in the cookie; the token itself is never stored.
  id              bytea PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  ip              inet,
  user_agent      text
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  ip          inet,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id);
