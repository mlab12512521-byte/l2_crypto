import type { TreeEntity } from '@texcollab/shared';
import { useCallback, useEffect, useState } from 'react';

interface TabState {
  open: string[];
  active: string | null;
}

function load(key: string): TabState {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as TabState | null;
    if (v && Array.isArray(v.open))
      return { open: v.open.filter((x) => typeof x === 'string'), active: v.active ?? null };
  } catch {
    // Unavailable or corrupt storage: start with no tabs.
  }
  return { open: [], active: null };
}

/** Open editor tabs for a project, remembered per browser, pruned when files disappear. */
export function useTabs(projectId: string, entities: TreeEntity[] | undefined, initial: string | null) {
  const key = `texcollab.tabs.${projectId}`;
  const [state, setState] = useState<TabState>(() => load(key));

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Ignore: tabs are a convenience.
    }
  }, [key, state]);

  // Drop tabs of deleted files/folders; open the main file on first visit.
  useEffect(() => {
    if (!entities) return;
    const ids = new Set(entities.filter((e) => e.kind !== 'folder').map((e) => e.id));
    setState((s) => {
      let open = s.open.filter((id) => ids.has(id));
      let active = s.active && ids.has(s.active) ? s.active : (open[0] ?? null);
      if (open.length === 0 && initial && ids.has(initial)) {
        open = [initial];
        active = initial;
      }
      return open.length === s.open.length && active === s.active ? s : { open, active };
    });
  }, [entities, initial]);

  const openTab = useCallback((id: string) => {
    setState((s) => ({ open: s.open.includes(id) ? s.open : [...s.open, id], active: id }));
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((s) => {
      const idx = s.open.indexOf(id);
      const open = s.open.filter((x) => x !== id);
      const active = s.active === id ? (open[Math.min(idx, open.length - 1)] ?? null) : s.active;
      return { open, active };
    });
  }, []);

  const activate = useCallback((id: string) => setState((s) => ({ ...s, active: id })), []);

  return { open: state.open, active: state.active, openTab, closeTab, activate };
}
