import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBanner, formatDateTime, Spinner } from '../../components/ui';

interface AuditItem {
  id: string;
  at: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  actor: string | null;
  details: Record<string, unknown>;
}

export function AuditPage() {
  const [action, setAction] = useState('');
  const audit = useQuery({
    queryKey: ['admin', 'audit', action],
    queryFn: () => api.get<{ items: AuditItem[] }>('/api/admin/audit', { query: { action, limit: 200 } }),
  });
  return (
    <div className="stack">
      <div className="toolbar">
        <h1>Audit log</h1>
        <select aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All events</option>
          <option value="auth.">Authentication</option>
          <option value="admin.">Administration</option>
          <option value="project.">Projects</option>
        </select>
      </div>
      {audit.isLoading && <Spinner />}
      <ErrorBanner error={audit.error} />
      {audit.data && (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Event</th>
              <th>Target</th>
              <th>IP</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.items.map((i) => (
              <tr key={i.id}>
                <td className="nowrap">{formatDateTime(i.at)}</td>
                <td>{i.actor ?? '—'}</td>
                <td>
                  <code>{i.action}</code>
                </td>
                <td className="small">{i.targetType ? `${i.targetType} ${i.targetId ?? ''}` : '—'}</td>
                <td className="small">{i.ip ?? '—'}</td>
                <td className="small mono">{Object.keys(i.details).length ? JSON.stringify(i.details) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
