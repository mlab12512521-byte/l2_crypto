import type { CompileDiagnostic, CompileResult } from '@texcollab/shared';
import { useState } from 'react';
import { projectsApi } from '../../api/projects';

type Filter = 'all' | 'error' | 'warning' | 'info';

export function LogsPanel({
  projectId,
  result,
  onOpen,
  onClose,
}: {
  projectId: string;
  result: CompileResult;
  onOpen: (d: CompileDiagnostic) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>(() =>
    result.diagnostics.some((d) => d.severity === 'error') ? 'error' : 'all',
  );
  const count = (s: Filter) => result.diagnostics.filter((d) => s === 'all' || d.severity === s).length;
  const shown = result.diagnostics.filter((d) => filter === 'all' || d.severity === filter);
  const logFiles = result.outputFiles.filter((f) => f.name.endsWith('.log') || f.name.endsWith('.blg'));
  return (
    <div className="logs-panel">
      <div className="logs-head">
        <div className="segmented" role="tablist" aria-label="Filter messages">
          {(
            [
              ['all', 'All'],
              ['error', 'Errors'],
              ['warning', 'Warnings'],
              ['info', 'Typesetting'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={filter === id ? 'active' : undefined}
              onClick={() => setFilter(id)}
            >
              {label} ({count(id)})
            </button>
          ))}
        </div>
        <div className="logs-links">
          {logFiles.map((f) => (
            <a
              key={f.name}
              href={projectsApi.buildFileUrl(projectId, result.buildId, f.name)}
              target="_blank"
              rel="noreferrer"
            >
              {f.name}
            </a>
          ))}
          <button type="button" className="btn btn-ghost btn-small" aria-label="Close logs" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      {result.message && <div className={`logs-message logs-${result.status}`}>{result.message}</div>}
      <ul className="logs-list">
        {shown.length === 0 && <li className="muted logs-empty">No messages.</li>}
        {shown.map((d) => (
          <li
            key={`${d.severity}|${d.source}|${d.file}|${d.line}|${d.message}`}
            className={`log-item log-item-${d.severity}`}
          >
            <button type="button" className="log-item-button" onClick={() => onOpen(d)} disabled={!d.entityId}>
              <span className="log-item-head">
                <span className={`badge badge-${d.severity}`}>{d.kind === 'badbox' ? 'box' : d.severity}</span>
                {d.file && (
                  <span className="log-item-loc">
                    {d.file}
                    {d.line ? `:${d.line}` : ''}
                  </span>
                )}
                <span className="muted small">{d.source}</span>
              </span>
              <span className="log-item-msg">{d.message}</span>
              {d.context && <pre className="log-item-context">{d.context}</pre>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
