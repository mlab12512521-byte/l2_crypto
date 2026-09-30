-- Phase 2: projects, membership, file tree, document contents, blobs.

CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- The entity to compile; nullable while the tree is being built or after the file is deleted.
  main_file_id     uuid,
  compiler         text NOT NULL DEFAULT 'pdflatex' CHECK (compiler IN ('pdflatex', 'xelatex', 'lualatex')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_modified_at timestamptz NOT NULL DEFAULT now(),
  last_modified_by uuid REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
-- Exactly one owner per project (the application creates it with the project).
CREATE UNIQUE INDEX project_members_one_owner ON project_members (project_id) WHERE role = 'owner';
CREATE INDEX project_members_user_idx ON project_members (user_id);

CREATE TABLE project_user_state (
  project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE blobs (
  hash       text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  size       bigint NOT NULL CHECK (size >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_entities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- NULL only for the project's root folder.
  parent_id  uuid REFERENCES project_entities (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('folder', 'doc', 'file')),
  name       text NOT NULL,
  blob_hash  text REFERENCES blobs (hash),
  size       bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT entity_blob_matches_kind CHECK ((kind = 'file') = (blob_hash IS NOT NULL)),
  CONSTRAINT entity_root_is_folder CHECK (parent_id IS NOT NULL OR (kind = 'folder' AND name = ''))
);
-- Names are unique within a folder; one root per project.
CREATE UNIQUE INDEX project_entities_unique_name ON project_entities (parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX project_entities_one_root ON project_entities (project_id) WHERE parent_id IS NULL;
CREATE INDEX project_entities_project_idx ON project_entities (project_id);
CREATE INDEX project_entities_blob_idx ON project_entities (blob_hash) WHERE blob_hash IS NOT NULL;

ALTER TABLE projects
  ADD CONSTRAINT projects_main_file_fk FOREIGN KEY (main_file_id) REFERENCES project_entities (id) ON DELETE SET NULL;

-- Live contents of editable text documents ('doc' entities).
CREATE TABLE doc_contents (
  entity_id    uuid PRIMARY KEY REFERENCES project_entities (id) ON DELETE CASCADE,
  -- Collaborative (Yjs) state; NULL until the document is first opened collaboratively.
  yjs_state    bytea,
  -- Plain-text mirror, always current: used for compilation, export, snapshots and search.
  text         text NOT NULL,
  content_hash text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users (id) ON DELETE SET NULL
);
