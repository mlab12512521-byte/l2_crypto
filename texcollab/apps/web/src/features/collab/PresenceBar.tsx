import type { TreeEntity } from '@texcollab/shared';
import type { ConnectionState, PresenceEntry } from './ProjectConnection';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

/** Who is in the project right now, and the state of the real-time connection. */
export function PresenceBar({
  presence,
  meId,
  state,
  files,
}: {
  presence: PresenceEntry[];
  meId: string;
  state: ConnectionState;
  files: Map<string, TreeEntity>;
}) {
  // One avatar per user, even with several tabs/devices open.
  const users = new Map<string, PresenceEntry & { count: number }>();
  for (const p of presence) {
    const prev = users.get(p.user.id);
    users.set(p.user.id, { ...p, openFile: p.openFile ?? prev?.openFile ?? null, count: (prev?.count ?? 0) + 1 });
  }
  const list = [...users.values()].sort((a, b) =>
    a.user.id === meId ? -1 : b.user.id === meId ? 1 : a.user.name.localeCompare(b.user.name),
  );
  return (
    <div className="presence">
      <span
        className={`conn conn-${state}`}
        title={state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Offline'}
      >
        {state === 'connected' ? '' : state === 'connecting' ? 'Connecting…' : 'Offline — reconnecting'}
      </span>
      <ul className="avatars" aria-label="People in this project">
        {list.map((u) => {
          const file = u.openFile ? files.get(u.openFile)?.name : null;
          const label = `${u.user.name}${u.user.id === meId ? ' (you)' : ''}${file ? ` — ${file}` : ''}`;
          return (
            <li
              key={u.user.id}
              className="avatar"
              style={{ background: u.user.color }}
              title={label}
              aria-label={label}
            >
              {initials(u.user.name)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
