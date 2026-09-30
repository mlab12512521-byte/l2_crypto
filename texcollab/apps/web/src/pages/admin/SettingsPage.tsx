import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBanner, Field, Spinner } from '../../components/ui';

interface Versioning {
  enabled: boolean;
  idleMinutes: number;
  maxMinutes: number;
}

export function SettingsPage() {
  const qc = useQueryClient();
  const registration = useQuery({
    queryKey: ['admin', 'settings', 'registration'],
    queryFn: () => api.get<{ enabled: boolean }>('/api/admin/settings/registration'),
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.put('/api/admin/settings/registration', { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'settings', 'registration'] }),
  });
  return (
    <div className="stack-lg">
      <h1>Settings</h1>
      <section className="card stack">
        <h2>Registration</h2>
        {registration.isLoading && <Spinner />}
        <ErrorBanner error={registration.error ?? save.error} />
        {registration.data && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={registration.data.enabled}
              disabled={save.isPending}
              onChange={(e) => save.mutate(e.target.checked)}
            />
            Allow anyone who can reach this site to create a local account
          </label>
        )}
        <p className="muted small">
          Keep this off for private deployments. Administrators can always create accounts, and directory (LDAP) users
          are created automatically at first sign-in.
        </p>
      </section>
      <VersioningSettings />
      <GitSettings />
    </div>
  );
}

function useSetting<T>(key: string) {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['admin', 'settings', key],
    queryFn: () => api.get<T>(`/api/admin/settings/${key}`),
  });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (value: T) => api.put<T>(`/api/admin/settings/${key}`, value),
    onMutate: () => setSaved(false),
    onSuccess: (v) => {
      qc.setQueryData(['admin', 'settings', key], v);
      setSaved(true);
    },
  });
  return { current, save, saved };
}

function VersioningSettings() {
  const { current, save, saved } = useSetting<Versioning>('versioning');
  const [form, setForm] = useState({ enabled: true, idleMinutes: '', maxMinutes: '' });
  useEffect(() => {
    if (current.data)
      setForm({
        enabled: current.data.enabled,
        idleMinutes: String(current.data.idleMinutes),
        maxMinutes: String(current.data.maxMinutes),
      });
  }, [current.data]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ enabled: form.enabled, idleMinutes: Number(form.idleMinutes), maxMinutes: Number(form.maxMinutes) });
  };
  return (
    <section className="card">
      <h2>Project history</h2>
      <p className="muted small">
        Automatic versions are saved when people stop editing for a while, and at the latest after a fixed time of
        continuous editing. Named versions, imports and restores are always recorded.
      </p>
      {current.isLoading && <Spinner />}
      <ErrorBanner error={current.error ?? save.error} />
      {saved && <div className="banner banner-success">Saved.</div>}
      {current.data && (
        <form onSubmit={submit} className="stack">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Create automatic versions
          </label>
          <div className="limits-grid">
            <Field
              label="After a pause of (minutes)"
              type="number"
              min={1}
              value={form.idleMinutes}
              onChange={(e) => setForm({ ...form, idleMinutes: e.target.value })}
            />
            <Field
              label="At the latest after (minutes)"
              type="number"
              min={5}
              value={form.maxMinutes}
              onChange={(e) => setForm({ ...form, maxMinutes: e.target.value })}
            />
            <div>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>
                Save
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}

function GitSettings() {
  const { current, save, saved } = useSetting<{ allowedHosts: string[] }>('git');
  const [hosts, setHosts] = useState('');
  useEffect(() => {
    if (current.data) setHosts(current.data.allowedHosts.join('\n'));
  }, [current.data]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ allowedHosts: hosts.split(/[\s,]+/).filter(Boolean) });
  };
  return (
    <section className="card">
      <h2>Git remotes</h2>
      <p className="muted small">
        Project owners can connect a project to an external Git repository over HTTPS. Leave the list empty to allow any
        public host; list host names (one per line) to allow only those. Internal servers on private addresses must be
        listed explicitly.
      </p>
      {current.isLoading && <Spinner />}
      <ErrorBanner error={current.error ?? save.error} />
      {saved && <div className="banner banner-success">Saved.</div>}
      {current.data && (
        <form onSubmit={submit} className="stack">
          <label className="field">
            <span>Allowed hosts</span>
            <textarea
              rows={4}
              value={hosts}
              placeholder={'github.com\ngitlab.example.org'}
              onChange={(e) => setHosts(e.target.value)}
            />
          </label>
          <div>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              Save
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
