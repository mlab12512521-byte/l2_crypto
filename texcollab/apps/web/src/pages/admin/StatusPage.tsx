import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { ErrorBanner, Spinner } from '../../components/ui';

interface Status {
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
  memory: { rssBytes: number; heapUsedBytes: number };
  database: { ok: boolean; version: string; latencyMs: number };
  users: { total: number };
  activeSessions: number;
}

export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

export function StatusPage() {
  const status = useQuery({
    queryKey: ['admin', 'status'],
    queryFn: () => api.get<Status>('/api/admin/status'),
    refetchInterval: 15_000,
  });
  const s = status.data;
  return (
    <div className="stack-lg">
      <h1>System status</h1>
      {status.isLoading && <Spinner />}
      <ErrorBanner error={status.error} />
      {s && (
        <div className="grid-cards">
          <div className="card stat">
            <div className="stat-label">Application</div>
            <div className="stat-value">v{s.version}</div>
            <div className="muted small">
              Node {s.nodeVersion}, up {formatUptime(s.uptimeSeconds)}, memory {formatBytes(s.memory.rssBytes)}
            </div>
          </div>
          <div className="card stat">
            <div className="stat-label">Database</div>
            <div className="stat-value">{s.database.ok ? 'Healthy' : 'Unavailable'}</div>
            <div className="muted small">
              PostgreSQL {s.database.version}, {s.database.latencyMs} ms
            </div>
          </div>
          <div className="card stat">
            <div className="stat-label">Users</div>
            <div className="stat-value">{s.users.total}</div>
            <div className="muted small">{s.activeSessions} active session(s)</div>
          </div>
        </div>
      )}
    </div>
  );
}
