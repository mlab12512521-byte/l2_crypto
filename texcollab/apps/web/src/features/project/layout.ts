import { useCallback, useMemo } from 'react';
import type { Layout } from 'react-resizable-panels';

/** Persist a panel group's layout in localStorage. */
export function useStoredLayout(key: string) {
  const initial = useMemo<Layout | undefined>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Layout | null;
      return v && typeof v === 'object' ? v : undefined;
    } catch {
      return undefined;
    }
  }, [key]);
  const save = useCallback(
    (layout: Layout) => {
      try {
        localStorage.setItem(key, JSON.stringify(layout));
      } catch {
        // Ignore: layout persistence is a convenience.
      }
    },
    [key],
  );
  return { initial, save };
}
