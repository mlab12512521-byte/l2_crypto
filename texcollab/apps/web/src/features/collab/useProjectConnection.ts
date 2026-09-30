import { type AwarenessUser, type ProjectEvent, userColor } from '@texcollab/shared';
import { useEffect, useRef, useState } from 'react';
import { type ConnectionState, type PresenceEntry, ProjectConnection } from './ProjectConnection';

/** Open the real-time connection for a project while the component is mounted. */
export function useProjectConnection(
  projectId: string,
  me: { id: string; displayName: string } | null,
  onEvent: (e: ProjectEvent) => void,
) {
  const [connection, setConnection] = useState<ProjectConnection | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;

  const meId = me?.id;
  const meName = me?.displayName;
  useEffect(() => {
    if (!meId || !meName) return;
    const identity: AwarenessUser = { id: meId, name: meName, ...userColor(meId) };
    const conn = new ProjectConnection(projectId, identity);
    const offState = conn.onState(setState);
    const offPresence = conn.onPresence(setPresence);
    const offEvent = conn.onEvent((e) => eventRef.current(e));
    setConnection(conn);
    return () => {
      offState();
      offPresence();
      offEvent();
      conn.destroy();
      setConnection(null);
    };
  }, [projectId, meId, meName]);

  return { connection, state, presence };
}
