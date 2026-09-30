-- Phase 4: compilation history.

CREATE TABLE compile_builds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  requested_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  engine        text NOT NULL CHECK (engine IN ('pdflatex', 'xelatex', 'lualatex')),
  main_file     text NOT NULL,
  status        text NOT NULL CHECK (status IN ('running', 'success', 'failure', 'timeout', 'error')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   integer,
  -- Names and sizes of stored output files, e.g. [{"name":"output.pdf","size":1234}]
  output_files  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Parsed errors/warnings (see compile/log-parser.ts); capped in size by the application.
  diagnostics   jsonb NOT NULL DEFAULT '[]'::jsonb,
  message       text
);
CREATE INDEX compile_builds_project_idx ON compile_builds (project_id, started_at DESC);
