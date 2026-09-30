import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBanner, Field, Spinner } from '../../components/ui';

interface WorkerHealth {
  url: string;
  ok: boolean;
  status: string;
  running?: number;
  queued?: number;
  concurrency?: number;
  maxQueued?: number;
  latencyMs?: number;
  error?: string;
}

interface CompileLimits {
  timeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  keepBuilds: number;
}

interface ProjectLimits {
  maxFileSizeMb: number;
  maxTextFileSizeMb: number;
  maxProjectSizeMb: number;
  maxEntitiesPerProject: number;
}

export function CompilationPage() {
  const workers = useQuery({
    queryKey: ['admin', 'workers'],
    queryFn: () => api.get<{ configured: boolean; workers: WorkerHealth[] }>('/api/admin/workers'),
    refetchInterval: 10_000,
  });
  return (
    <div className="stack-lg">
      <h1>Compilation and limits</h1>
      <section className="card stack">
        <h2>Compile workers</h2>
        {workers.isLoading && <Spinner />}
        <ErrorBanner error={workers.error} />
        {workers.data && !workers.data.configured && (
          <div className="banner banner-error">
            No compile workers are configured (COMPILE_WORKERS / WORKER_SECRET).
          </div>
        )}
        {workers.data && workers.data.workers.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Status</th>
                <th>Running</th>
                <th>Queued</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {workers.data.workers.map((w) => (
                <tr key={w.url}>
                  <td className="mono">{w.url}</td>
                  <td>
                    <span className={`badge ${w.ok ? 'badge-accent' : 'badge-danger'}`}>{w.status}</span>
                    {w.error && <div className="muted small">{w.error}</div>}
                  </td>
                  <td>{w.ok ? `${w.running} / ${w.concurrency}` : '—'}</td>
                  <td>{w.ok ? `${w.queued} / ${w.maxQueued}` : '—'}</td>
                  <td>{w.latencyMs !== undefined ? `${w.latencyMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <LimitsForm<CompileLimits>
        title="Compilation limits"
        settingKey="compileLimits"
        description="Applied to every compilation. Workers additionally enforce their own maximums (MAX_TIMEOUT_SECONDS, MAX_MEMORY_MB, MAX_CPUS)."
        fields={[
          { key: 'timeoutSeconds', label: 'Time limit (seconds)', step: 1 },
          { key: 'memoryMb', label: 'Memory limit (MB)', step: 64 },
          { key: 'cpus', label: 'CPU limit (cores)', step: 0.25 },
          { key: 'keepBuilds', label: 'Builds kept per project', step: 1 },
        ]}
      />
      <LimitsForm<ProjectLimits>
        title="Project storage limits"
        settingKey="projectLimits"
        description="Checked on every upload, import and file creation."
        fields={[
          { key: 'maxFileSizeMb', label: 'Largest uploaded file (MB)', step: 1 },
          { key: 'maxTextFileSizeMb', label: 'Largest editable text file (MB)', step: 1 },
          { key: 'maxProjectSizeMb', label: 'Project size (MB)', step: 1 },
          { key: 'maxEntitiesPerProject', label: 'Files and folders per project', step: 1 },
        ]}
      />
    </div>
  );
}

function LimitsForm<T extends object>({
  title,
  settingKey,
  description,
  fields,
}: {
  title: string;
  settingKey: string;
  description: string;
  fields: Array<{ key: keyof T & string; label: string; step: number }>;
}) {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['admin', 'settings', settingKey],
    queryFn: () => api.get<T>(`/api/admin/settings/${settingKey}`),
  });
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (current.data) setForm(Object.fromEntries(Object.entries(current.data).map(([k, v]) => [k, String(v)])));
  }, [current.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put<T>(
        `/api/admin/settings/${settingKey}`,
        Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)])),
      ),
    onSuccess: (v) => {
      qc.setQueryData(['admin', 'settings', settingKey], v);
      setSaved(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    save.mutate();
  };
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted small">{description}</p>
      {current.isLoading && <Spinner />}
      <ErrorBanner error={current.error ?? save.error} />
      {saved && <div className="banner banner-success">Saved.</div>}
      {current.data && (
        <form onSubmit={submit} className="limits-grid">
          {fields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              type="number"
              step={f.step}
              value={form[f.key] ?? ''}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          ))}
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
