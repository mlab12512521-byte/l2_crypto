import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBanner, Spinner } from '../../components/ui';

interface LogItem {
  seq: number;
  time: string | number;
  level: number;
  levelName?: string;
  msg: string;
  [key: string]: unknown;
}

const HIDDEN_KEYS = new Set(['seq', 'time', 'level', 'levelName', 'msg', 'service', 'pid', 'hostname']);

export function LogsPage() {
  const [level, setLevel] = useState('info');
  const logs = useQuery({
    queryKey: ['admin', 'logs', level],
    queryFn: () => api.get<{ items: LogItem[] }>('/api/admin/logs', { query: { level, limit: 500 } }),
    refetchInterval: 10_000,
  });
  return (
    <div className="stack">
      <div className="toolbar">
        <h1>Application logs</h1>
        <select aria-label="Minimum level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="debug">Debug and above</option>
          <option value="info">Info and above</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </select>
      </div>
      <p className="muted small">
        Most recent entries held in memory by this app instance. Full logs are available through Docker.
      </p>
      {logs.isLoading && <Spinner />}
      <ErrorBanner error={logs.error} />
      {logs.data && (
        <div className="log-view" role="log">
          {logs.data.items.map((l) => {
            const extra = Object.fromEntries(Object.entries(l).filter(([k]) => !HIDDEN_KEYS.has(k)));
            return (
              <div key={l.seq} className={`log-line log-${l.levelName ?? 'info'}`}>
                <span className="log-time">{String(l.time)}</span>
                <span className="log-level">{l.levelName ?? l.level}</span>
                <span className="log-msg">{l.msg}</span>
                {Object.keys(extra).length > 0 && <span className="log-extra">{JSON.stringify(extra)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
