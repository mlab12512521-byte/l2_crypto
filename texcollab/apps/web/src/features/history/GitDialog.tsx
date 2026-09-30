import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDetails } from '@texcollab/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { historyApi } from '../../api/history';
import { ErrorBanner, Field, formatDateTime, Modal, Spinner } from '../../components/ui';

/** External Git remote: configuration (owner) and push/pull (editors). */
export function GitDialog({
  project,
  onClose,
  onPulled,
}: {
  project: ProjectDetails;
  onClose: () => void;
  onPulled: () => void;
}) {
  const qc = useQueryClient();
  const key = ['project', project.id, 'git'];
  const git = useQuery({ queryKey: key, queryFn: () => historyApi.git(project.id) });
  const isOwner = project.role === 'owner';
  const canSync = project.role !== 'viewer';
  const remote = git.data?.remote ?? null;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ url: '', branch: 'main', username: '', token: '' });
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (remote) setForm({ url: remote.url, branch: remote.branch, username: remote.username ?? '', token: '' });
  }, [remote]);

  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: () =>
      historyApi.setRemote(project.id, {
        url: form.url,
        branch: form.branch,
        username: form.username || null,
        // Empty token field keeps the stored token.
        ...(form.token ? { token: form.token } : {}),
      }),
    onSuccess: () => {
      setEditing(false);
      setForm((f) => ({ ...f, token: '' }));
      void refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => historyApi.removeRemote(project.id), onSuccess: refresh });
  const push = useMutation({
    mutationFn: () => historyApi.push(project.id),
    onSuccess: () => {
      setMessage('Pushed to the remote repository.');
      void refresh();
    },
    onError: () => void refresh(),
  });
  const pull = useMutation({
    mutationFn: () => historyApi.pull(project.id),
    onSuccess: (r) => {
      if (r.conflicts?.length)
        setMessage(
          `Not pulled: conflicting changes in ${r.conflicts.join(', ')}. Resolve by editing here or on the remote, then try again.`,
        );
      else
        setMessage(r.result === 'up-to-date' ? 'Already up to date.' : 'Pulled the remote changes into the project.');
      void refresh();
      onPulled();
    },
    onError: () => void refresh(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Modal title="Git" onClose={onClose}>
      <div className="stack">
        <p className="muted small">
          Every project already keeps its own history (see <strong>History</strong>). Optionally connect an external
          repository on GitHub, GitLab, Gitea or any HTTPS Git server to push and pull.
        </p>
        {git.isLoading && <Spinner />}
        <ErrorBanner error={git.error ?? save.error ?? remove.error ?? push.error ?? pull.error} />
        {message && <div className="banner banner-success">{message}</div>}
        {remote && !editing && (
          <div className="card stack">
            <dl className="kv">
              <dt>Repository</dt>
              <dd className="mono small">{remote.url}</dd>
              <dt>Branch</dt>
              <dd>{remote.branch}</dd>
              <dt>Credentials</dt>
              <dd>
                {remote.hasSecret
                  ? `Token stored${remote.username ? ` (user ${remote.username})` : ''}`
                  : 'None (public repository)'}
              </dd>
              <dt>Last push</dt>
              <dd>{formatDateTime(remote.lastPushAt)}</dd>
              <dt>Last pull</dt>
              <dd>{formatDateTime(remote.lastPullAt)}</dd>
            </dl>
            {remote.lastError && <div className="banner banner-error">{remote.lastError}</div>}
            <div className="modal-actions">
              {isOwner && (
                <>
                  <button type="button" className="btn" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => confirm('Disconnect the remote repository?') && remove.mutate()}
                  >
                    Disconnect
                  </button>
                </>
              )}
              {canSync && (
                <>
                  <button
                    type="button"
                    className="btn"
                    disabled={pull.isPending || push.isPending}
                    onClick={() => pull.mutate()}
                  >
                    {pull.isPending ? 'Pulling…' : 'Pull'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={pull.isPending || push.isPending}
                    onClick={() => push.mutate()}
                  >
                    {push.isPending ? 'Pushing…' : 'Push'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {!remote && !editing && git.data && (
          <div className="empty-state muted">
            No external repository connected.
            {isOwner && (
              <div>
                <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
                  Connect a repository
                </button>
              </div>
            )}
          </div>
        )}
        {editing && isOwner && (
          <form className="stack" onSubmit={submit} noValidate>
            <Field
              label="Repository URL (https)"
              placeholder="https://github.com/org/paper.git"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
            <Field label="Branch" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
            <Field
              label="Username (optional)"
              value={form.username}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <Field
              label={
                remote?.hasSecret
                  ? 'Access token (leave empty to keep the stored one)'
                  : 'Access token (optional for public repositories)'
              }
              type="password"
              autoComplete="new-password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              hint={git.data?.providers.find((p) => p.id === (git.data?.provider ?? 'generic'))?.tokenHelp}
            />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={save.isPending || !form.url}>
                Save
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
