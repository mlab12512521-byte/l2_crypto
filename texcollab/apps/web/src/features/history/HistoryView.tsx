import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileChange, ProjectDetails, VersionInfo } from '@texcollab/shared';
import { useEffect, useState } from 'react';
import { historyApi } from '../../api/history';
import { ErrorBanner, Spinner } from '../../components/ui';
import { DiffViewer } from './DiffViewer';
import { groupByDay, KIND_LABEL, versionAuthors } from './group';

export const versionsKey = (projectId: string) => ['project', projectId, 'versions'] as const;

type Compare = 'previous' | 'current';

/**
 * Version history: browse versions by day, see what changed in each (or
 * compared with now), view line diffs, download or restore a version.
 */
export function HistoryView({
  project,
  onClose,
  onRestored,
}: {
  project: ProjectDetails;
  onClose: () => void;
  onRestored: () => void;
}) {
  const qc = useQueryClient();
  const canEdit = project.role !== 'viewer';
  const list = useQuery({ queryKey: versionsKey(project.id), queryFn: () => historyApi.list(project.id) });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compare, setCompare] = useState<Compare>('previous');
  const [file, setFile] = useState<string | null>(null);
  const versions = list.data?.versions ?? [];
  const selected = versions.find((v) => v.id === selectedId) ?? versions[0] ?? null;
  const previous = selected ? versions[versions.indexOf(selected) + 1] : undefined;

  // "What changed in this version" = previous → selected; "compared with now" = selected → current.
  const from = compare === 'previous' ? previous?.id : selected?.id;
  const to = compare === 'previous' ? selected?.id : 'current';
  const diff = useQuery({
    queryKey: ['project', project.id, 'diff', from ?? 'root', to],
    queryFn: () => historyApi.diff(project.id, to!, from),
    enabled: !!to,
  });
  useEffect(() => {
    // Keep the chosen file when switching versions if it still changed, else pick the first.
    const changes = diff.data?.changes ?? [];
    if (!changes.some((c) => c.path === file)) setFile(changes[0]?.path ?? null);
  }, [diff.data, file]);

  const save = useMutation({
    mutationFn: (label: string) => historyApi.save(project.id, label),
    onSuccess: () => qc.invalidateQueries({ queryKey: versionsKey(project.id) }),
  });
  const restore = useMutation({
    mutationFn: (v: VersionInfo) => historyApi.restore(project.id, v.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: versionsKey(project.id) });
      onRestored();
    },
  });

  return (
    <div className="history">
      <aside className="history-sidebar">
        <div className="panel-toolbar">
          <span className="panel-title">History</span>
          {canEdit && (
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={save.isPending}
              onClick={() => {
                const label = prompt('Name this version (e.g. "Submitted to journal")');
                if (label?.trim()) save.mutate(label.trim());
              }}
            >
              Save version
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
            Back to editor
          </button>
        </div>
        <ErrorBanner error={list.error ?? save.error ?? restore.error} />
        {list.isLoading && <Spinner />}
        {list.data?.dirty && (
          <div className="history-dirty muted small">Unsaved changes will be saved as a version automatically.</div>
        )}
        <div className="version-list">
          {groupByDay(versions).map((g) => (
            <section key={g.label}>
              <h3 className="version-day">{g.label}</h3>
              <ul>
                {g.items.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      className={`version${v.id === selected?.id ? ' selected' : ''}`}
                      onClick={() => setSelectedId(v.id)}
                    >
                      <span className="version-time">
                        {new Date(v.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="version-who">{versionAuthors(v)}</span>
                      {(v.label || KIND_LABEL[v.kind]) && (
                        <span className="version-label">{v.label ?? KIND_LABEL[v.kind]}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
      <section className="history-main">
        {selected && (
          <div className="history-toolbar">
            <div className="segmented" role="tablist" aria-label="Compare">
              <button
                type="button"
                role="tab"
                aria-selected={compare === 'previous'}
                className={compare === 'previous' ? 'active' : undefined}
                onClick={() => setCompare('previous')}
              >
                Changes in this version
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={compare === 'current'}
                className={compare === 'current' ? 'active' : undefined}
                onClick={() => setCompare('current')}
              >
                Compare with now
              </button>
            </div>
            <div className="history-actions">
              <a className="btn btn-small" href={historyApi.downloadUrl(project.id, selected.id)} download>
                Download
              </a>
              {canEdit && selected.id !== versions[0]?.id && (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={restore.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        'Restore this version? The current state is saved as a version first, so nothing is lost.',
                      )
                    )
                      restore.mutate(selected);
                  }}
                >
                  {restore.isPending ? 'Restoring…' : 'Restore this version'}
                </button>
              )}
            </div>
          </div>
        )}
        <div className="history-body">
          <ul className="change-list" aria-label="Changed files">
            {diff.isLoading && <Spinner />}
            {diff.data && diff.data.changes.length === 0 && (
              <li className="muted small change-empty">No file changes.</li>
            )}
            {diff.data?.changes.map((c) => (
              <li key={c.path}>
                <button
                  type="button"
                  className={`change change-${c.status}${c.path === file ? ' selected' : ''}`}
                  onClick={() => setFile(c.path)}
                >
                  <span className="change-status">
                    {c.status === 'added' ? 'A' : c.status === 'deleted' ? 'D' : 'M'}
                  </span>
                  <span className="change-path">{c.path}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="diff-pane">
            {file && diff.data && (
              <FileDiff
                projectId={project.id}
                change={diff.data.changes.find((c) => c.path === file)!}
                from={from}
                to={to!}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function FileDiff({
  projectId,
  change,
  from,
  to,
}: {
  projectId: string;
  change: FileChange;
  from: string | undefined;
  to: string;
}) {
  const texts = useQuery({
    queryKey: ['project', projectId, 'filediff', from ?? 'root', to, change.path],
    queryFn: async () => {
      const [a, b] = await Promise.all([
        change.status === 'added' || !from ? Promise.resolve('') : historyApi.fileText(projectId, from, change.path),
        change.status === 'deleted' ? Promise.resolve('') : historyApi.fileText(projectId, to, change.path),
      ]);
      return { a, b };
    },
    enabled: !!change,
  });
  if (!change) return null;
  if (change.binary) return <div className="empty-state muted">Binary file ({change.status}).</div>;
  if (texts.isLoading) return <Spinner />;
  if (texts.error) return <ErrorBanner error={texts.error} />;
  const a = texts.data?.a;
  const b = texts.data?.b;
  if (a === 'binary' || b === 'binary') return <div className="empty-state muted">Binary file.</div>;
  return (
    <>
      <div className="diff-title mono small">{change.path}</div>
      <DiffViewer oldText={a ?? ''} newText={b ?? ''} />
    </>
  );
}
