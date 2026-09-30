import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectSummary } from '@texcollab/shared';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { importProject, type ProjectFilter, type ProjectSort, projectsApi } from '../api/projects';
import { ErrorBanner, Field, Modal, Spinner } from '../components/ui';
import { relativeTime } from '../lib/time';

const FILTERS: Array<{ id: ProjectFilter; label: string }> = [
  { id: 'all', label: 'All projects' },
  { id: 'owned', label: 'Owned by me' },
  { id: 'shared', label: 'Shared with me' },
];

export const PROJECTS_KEY = ['projects'] as const;

export function DashboardPage() {
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [sort, setSort] = useState<ProjectSort>('lastModified');
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const projects = useQuery({
    queryKey: [...PROJECTS_KEY, filter, sort, q],
    queryFn: () => projectsApi.list({ filter, sort, q }),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="stack">
      <div className="toolbar">
        <h1>Projects</h1>
        <button className="btn" type="button" onClick={() => setDialog('import')}>
          Upload project
        </button>
        <button className="btn btn-primary" type="button" onClick={() => setDialog('new')}>
          New project
        </button>
      </div>
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="Project filter">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={filter === f.id ? 'active' : undefined}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="search"
          placeholder="Search projects…"
          aria-label="Search projects"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as ProjectSort)}>
          <option value="lastModified">Last modified</option>
          <option value="lastOpened">Recently opened</option>
          <option value="name">Name</option>
          <option value="created">Created</option>
        </select>
      </div>
      <ErrorBanner error={projects.error} />
      {projects.isLoading && <Spinner />}
      {projects.data && projects.data.length === 0 && (
        <div className="card empty-state">
          <p>{q ? 'No projects match your search.' : 'No projects yet.'}</p>
          {!q && (
            <button className="btn btn-primary" type="button" onClick={() => setDialog('new')}>
              Create your first project
            </button>
          )}
        </div>
      )}
      {projects.data && projects.data.length > 0 && (
        <table className="table project-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Owner</th>
              <th>Last modified</th>
              <th>Last opened</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {projects.data.map((p) => (
              <ProjectRow key={p.id} project={p} onRename={() => setRenaming(p)} />
            ))}
          </tbody>
        </table>
      )}
      {dialog === 'new' && <NewProjectModal onClose={() => setDialog(null)} />}
      {dialog === 'import' && <ImportProjectModal onClose={() => setDialog(null)} />}
      {renaming && <RenameProjectModal project={renaming} onClose={() => setRenaming(null)} />}
    </div>
  );
}

function ProjectRow({ project: p, onRename }: { project: ProjectSummary; onRename: () => void }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => projectsApi.remove(p.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROJECTS_KEY }),
    onError: (e) => alert(e.message),
  });
  return (
    <tr>
      <td>
        <Link to={`/project/${p.id}`} className="strong">
          {p.name}
        </Link>
        {p.role !== 'owner' && (
          <span className="badge badge-role">{p.role === 'editor' ? 'Can edit' : 'Read only'}</span>
        )}
      </td>
      <td>{p.role === 'owner' ? 'You' : p.owner.displayName}</td>
      <td title={new Date(p.lastModifiedAt).toLocaleString()}>
        {relativeTime(p.lastModifiedAt)}
        {p.lastModifiedBy && <span className="muted small"> by {p.lastModifiedBy.displayName}</span>}
      </td>
      <td className="muted">{p.lastOpenedAt ? relativeTime(p.lastOpenedAt) : '—'}</td>
      <td>
        <div className="actions">
          <a className="btn btn-small" href={projectsApi.exportUrl(p.id)} download>
            Download
          </a>
          {p.role === 'owner' && (
            <>
              <button className="btn btn-small" type="button" onClick={onRename}>
                Rename
              </button>
              <button
                className="btn btn-small btn-danger"
                type="button"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(`Delete "${p.name}" and all its files and history? This cannot be undone.`))
                    remove.mutate();
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<'article' | 'blank'>('article');
  const create = useMutation({
    mutationFn: () => projectsApi.create(name, template),
    onSuccess: (p) => navigate(`/project/${p.id}`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <ErrorBanner error={create.error} />
        <Field label="Project name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <fieldset className="radio-group">
          <legend>Start from</legend>
          <label className="checkbox">
            <input type="radio" name="tpl" checked={template === 'article'} onChange={() => setTemplate('article')} />
            Basic article (main.tex)
          </label>
          <label className="checkbox">
            <input type="radio" name="tpl" checked={template === 'blank'} onChange={() => setTemplate('blank')} />
            Empty project
          </label>
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImportProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const run = useMutation({
    mutationFn: () => importProject(name, file!, setProgress),
    onSuccess: (p) => navigate(`/project/${p.id}`),
  });
  const choose = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    if (!name) setName(f.name.replace(/\.zip$/i, ''));
  };
  return (
    <Modal title="Upload project" onClose={onClose}>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <ErrorBanner error={run.error} />
        <label
          className={`dropzone${dragOver ? ' dropzone-active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            choose(e.dataTransfer.files[0]);
          }}
        >
          <input type="file" accept=".zip,application/zip" hidden onChange={(e) => choose(e.target.files?.[0])} />
          {file ? <strong>{file.name}</strong> : 'Drop a .zip file here or click to choose one'}
        </label>
        <Field label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        {run.isPending && <progress max={1} value={progress} className="progress" />}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!file || !name.trim() || run.isPending}>
            Upload
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RenameProjectModal({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(project.name);
  const save = useMutation({
    mutationFn: () => projectsApi.update(project.id, { name }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: PROJECTS_KEY });
      onClose();
    },
  });
  return (
    <Modal title="Rename project" onClose={onClose}>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <ErrorBanner error={save.error} />
        <Field label="Project name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || save.isPending}>
            Rename
          </button>
        </div>
      </form>
    </Modal>
  );
}
