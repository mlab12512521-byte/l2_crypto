import { useMutation } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH } from '@texcollab/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../api/client';
import { ErrorBanner, Field, fieldErrors } from './ui';

export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => api.post('/api/auth/password', { currentPassword, newPassword }),
    onSuccess: () => {
      setCurrent('');
      setNew('');
      setConfirm('');
      onDone();
    },
  });
  const errors = fieldErrors(change.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) {
      setLocalError('The new passwords do not match');
      return;
    }
    setLocalError(null);
    change.mutate();
  };
  return (
    <form onSubmit={submit} noValidate className="stack">
      <ErrorBanner error={localError ? new Error(localError) : change.error} />
      <Field
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrent(e.target.value)}
        error={errors.currentPassword}
      />
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNew(e.target.value)}
        error={errors.newPassword}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters; must not contain your username.`}
      />
      <Field
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <div>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={change.isPending || !currentPassword || !newPassword}
        >
          Change password
        </button>
      </div>
    </form>
  );
}
