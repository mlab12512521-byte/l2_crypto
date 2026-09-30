import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDetails, PublicUser } from '@texcollab/shared';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sharingApi } from '../../api/sharing';
import { ErrorBanner, Modal, Spinner } from '../../components/ui';

type ShareRole = 'editor' | 'viewer';

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const membersKey = (projectId: string) => ['project', projectId, 'members'] as const;

export function ShareDialog({
  project,
  meId,
  onClose,
}: {
  project: ProjectDetails;
  meId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isOwner = project.role === 'owner';
  const members = useQuery({ queryKey: membersKey(project.id), queryFn: () => sharingApi.members(project.id) });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: membersKey(project.id) });
    void qc.invalidateQueries({ queryKey: ['project', project.id], exact: true });
  };
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: invalidate,
    onError: setError,
  });
  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    run.mutate(fn);
  };

  return (
    <Modal title={`Share “${project.name}”`} onClose={onClose}>
      <div className="stack">
        <ErrorBanner error={error} />
        {notice && <div className="banner banner-success">{notice}</div>}
        {isOwner && (
          <AddPeople
            onShare={(target, role) =>
              act(async () => {
                const r = await sharingApi.share(project.id, { ...target, role });
                setNotice(
                  r.kind === 'invitation' ? 'Invitation saved. They will get access when they first sign in.' : null,
                );
              })
            }
            busy={run.isPending}
          />
        )}
        {members.isLoading && <Spinner />}
        {members.data && (
          <ul className="member-list">
            {members.data.members.map((m) => (
              <li key={m.user.id} className="member">
                <div className="member-who">
                  <span className="strong">
                    {m.user.displayName}
                    {m.user.id === meId && ' (you)'}
                  </span>
                  <span className="muted small">{m.user.username}</span>
                </div>
                {isOwner && m.role !== 'owner' ? (
                  <div className="member-actions">
                    <select
                      aria-label={`Access for ${m.user.displayName}`}
                      value={m.role}
                      onChange={(e) => {
                        // Read the value now: the controlled select is reset before the request runs.
                        const next = e.target.value as ShareRole;
                        act(() => sharingApi.setRole(project.id, m.user.id, next));
                      }}
                    >
                      <option value="editor">Can edit</option>
                      <option value="viewer">Can view</option>
                    </select>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        if (
                          confirm(`Make ${m.user.displayName} the owner of this project? You will become an editor.`)
                        ) {
                          act(() => sharingApi.transfer(project.id, m.user.id));
                        }
                      }}
                    >
                      Make owner
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      aria-label={`Remove ${m.user.displayName}`}
                      onClick={() => act(() => sharingApi.remove(project.id, m.user.id))}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <span className="badge">{ROLE_LABEL[m.role]}</span>
                )}
              </li>
            ))}
            {members.data.invitations.map((i) => (
              <li key={i.id} className="member member-invited">
                <div className="member-who">
                  <span>{i.email}</span>
                  <span className="muted small">Invited · {ROLE_LABEL[i.role]} · waiting for first sign-in</span>
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => act(() => sharingApi.cancelInvitation(project.id, i.id))}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
        {!isOwner && (
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                if (confirm('Leave this project? You will lose access until the owner shares it again.')) {
                  sharingApi.remove(project.id, meId).then(() => navigate('/'), setError);
                }
              }}
            >
              Leave project
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function AddPeople({
  onShare,
  busy,
}: {
  onShare: (target: { userId?: string; identifier?: string }, role: ShareRole) => void;
  busy: boolean;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useState<ShareRole>('editor');
  const [picked, setPicked] = useState<PublicUser | null>(null);
  const listId = useId();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const results = useQuery({
    queryKey: ['user-search', debounced],
    queryFn: () => sharingApi.searchUsers(debounced),
    enabled: debounced.length >= 2 && !picked,
  });
  const isEmail = EMAIL.test(q.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (picked) onShare({ userId: picked.id }, role);
    else if (q.trim()) onShare({ identifier: q.trim() }, role);
    setQ('');
    setPicked(null);
  };
  return (
    <form className="add-people" onSubmit={submit}>
      <div className="add-people-input">
        <input
          type="text"
          role="combobox"
          aria-expanded={!!results.data?.length && !picked}
          aria-controls={listId}
          aria-label="Name, username or e-mail address"
          placeholder="Name, username or e-mail address"
          value={picked ? `${picked.displayName} (${picked.username})` : q}
          onChange={(e) => {
            setPicked(null);
            setQ(e.target.value);
          }}
        />
        {!picked && results.data && results.data.length > 0 && (
          <ul id={listId} className="suggestions">
            {results.data.map((u) => (
              <li key={u.id}>
                <button type="button" onClick={() => setPicked(u)}>
                  <span className="strong">{u.displayName}</span> <span className="muted small">{u.username}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <select aria-label="Access" value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
        <option value="editor">Can edit</option>
        <option value="viewer">Can view</option>
      </select>
      <button type="submit" className="btn btn-primary" disabled={busy || (!picked && !q.trim())}>
        {!picked && isEmail && !results.data?.length ? 'Invite' : 'Share'}
      </button>
    </form>
  );
}
