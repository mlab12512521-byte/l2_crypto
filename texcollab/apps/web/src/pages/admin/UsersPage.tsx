import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminUser, Paginated } from '@texcollab/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBanner, Field, fieldErrors, formatDateTime, Modal, Spinner } from '../../components/ui';

const USERS_KEY = ['admin', 'users'] as const;

export function UsersPage() {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const users = useQuery({
    queryKey: [...USERS_KEY, q],
    queryFn: () => api.get<Paginated<AdminUser>>('/api/admin/users', { query: { q, limit: 200 } }),
  });

  return (
    <div className="stack">
      <div className="toolbar">
        <h1>Users</h1>
        <input
          type="search"
          className="search"
          placeholder="Search users…"
          aria-label="Search users"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
          New user
        </button>
      </div>
      {users.isLoading && <Spinner />}
      <ErrorBanner error={users.error} />
      {users.data && (
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>E-mail</th>
              <th>Type</th>
              <th>Status</th>
              <th>Last login</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {users.data.items.map((u) => (
              <UserRow key={u.id} user={u} onEdit={() => setEditing(u)} onResetPassword={() => setResetting(u)} />
            ))}
          </tbody>
        </table>
      )}
      {users.data && <p className="muted">{users.data.total} user(s)</p>}
      {creating && <CreateUserModal onClose={() => setCreating(false)} />}
      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} />}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

function UserRow({
  user,
  onEdit,
  onResetPassword,
}: {
  user: AdminUser;
  onEdit: () => void;
  onResetPassword: () => void;
}) {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const invalidate = () => qc.invalidateQueries({ queryKey: USERS_KEY });
  const patch = useMutation({
    mutationFn: (body: Partial<Pick<AdminUser, 'isAdmin' | 'isDisabled'>>) =>
      api.patch(`/api/admin/users/${user.id}`, body),
    onSuccess: invalidate,
    onError: (e) => alert(e.message),
  });
  const unlock = useMutation({
    mutationFn: () => api.post(`/api/admin/users/${user.id}/unlock`),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/admin/users/${user.id}`),
    onSuccess: invalidate,
    onError: (e) => alert(e.message),
  });
  const isSelf = me?.id === user.id;
  return (
    <tr className={user.isDisabled ? 'row-muted' : undefined}>
      <td>
        <div className="strong">{user.displayName}</div>
        <div className="muted small">{user.username}</div>
      </td>
      <td>{user.email ?? '—'}</td>
      <td>{user.authSource === 'ldap' ? 'LDAP' : 'Local'}</td>
      <td>
        <div className="badges">
          {user.isAdmin && <span className="badge badge-accent">Admin</span>}
          {user.isDisabled && <span className="badge badge-danger">Disabled</span>}
          {user.lockedUntil && <span className="badge badge-warn">Locked</span>}
          {user.mustChangePassword && <span className="badge">Password change pending</span>}
        </div>
      </td>
      <td>{formatDateTime(user.lastLoginAt)}</td>
      <td>
        <div className="actions">
          <button className="btn btn-small" type="button" onClick={onEdit}>
            Edit
          </button>
          {user.authSource === 'local' && (
            <button className="btn btn-small" type="button" onClick={onResetPassword}>
              Reset password
            </button>
          )}
          {user.lockedUntil && (
            <button className="btn btn-small" type="button" onClick={() => unlock.mutate()}>
              Unlock
            </button>
          )}
          {!isSelf && (
            <>
              <button className="btn btn-small" type="button" onClick={() => patch.mutate({ isAdmin: !user.isAdmin })}>
                {user.isAdmin ? 'Revoke admin' : 'Make admin'}
              </button>
              <button
                className="btn btn-small"
                type="button"
                onClick={() => patch.mutate({ isDisabled: !user.isDisabled })}
              >
                {user.isDisabled ? 'Enable' : 'Disable'}
              </button>
              <button
                className="btn btn-small btn-danger"
                type="button"
                onClick={() => {
                  if (confirm(`Delete user ${user.username}? This cannot be undone. Consider disabling instead.`))
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

function CreateUserModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    username: '',
    displayName: '',
    email: '',
    password: '',
    isAdmin: false,
    mustChangePassword: true,
  });
  const create = useMutation({
    mutationFn: () => api.post<AdminUser>('/api/admin/users', { ...form, email: form.email.trim() || null }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: USERS_KEY });
      onClose();
    },
  });
  const errors = fieldErrors(create.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Modal title="New local user" onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        <ErrorBanner error={create.error} />
        <Field
          label="Username"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          error={errors.username}
        />
        <Field
          label="Display name"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          error={errors.displayName}
        />
        <Field
          label="E-mail (optional)"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          error={errors.email}
        />
        <Field
          label="Initial password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          error={errors.password}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.mustChangePassword}
            onChange={(e) => setForm({ ...form, mustChangePassword: e.target.checked })}
          />
          Require password change at first login
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.isAdmin}
            onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })}
          />
          Administrator
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            Create user
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email ?? '');
  const save = useMutation({
    mutationFn: () => api.patch(`/api/admin/users/${user.id}`, { displayName, email: email.trim() || null }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: USERS_KEY });
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  return (
    <Modal title={`Edit ${user.username}`} onClose={onClose}>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <ErrorBanner error={save.error} />
        <Field
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
        />
        <Field
          label="E-mail"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [mustChangePassword, setMustChange] = useState(true);
  const reset = useMutation({
    mutationFn: () => api.post(`/api/admin/users/${user.id}/password`, { password, mustChangePassword }),
    onSuccess: onClose,
  });
  return (
    <Modal title={`Reset password for ${user.username}`} onClose={onClose}>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          reset.mutate();
        }}
      >
        <ErrorBanner error={reset.error} />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors(reset.error).password}
        />
        <label className="checkbox">
          <input type="checkbox" checked={mustChangePassword} onChange={(e) => setMustChange(e.target.checked)} />
          Require password change at next login
        </label>
        <p className="muted small">All of the user's sessions will be signed out.</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={reset.isPending}>
            Reset password
          </button>
        </div>
      </form>
    </Modal>
  );
}
