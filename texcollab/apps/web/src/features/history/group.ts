import type { VersionInfo } from '@texcollab/shared';

/** Group versions by calendar day: "Today", "Yesterday", or a date. */
export function groupByDay(versions: VersionInfo[], now = new Date()): Array<{ label: string; items: VersionInfo[] }> {
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = dayKey(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y);
  const groups: Array<{ label: string; items: VersionInfo[] }> = [];
  for (const v of versions) {
    const d = new Date(v.createdAt);
    const key = dayKey(d);
    const label =
      key === today
        ? 'Today'
        : key === yesterday
          ? 'Yesterday'
          : d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(v);
    else groups.push({ label, items: [v] });
  }
  return groups;
}

export function versionAuthors(v: VersionInfo): string {
  const names = v.contributors.length
    ? v.contributors.map((c) => c.displayName)
    : v.createdBy
      ? [v.createdBy.displayName]
      : [];
  return names.length ? names.join(', ') : 'TeXCollab';
}

export const KIND_LABEL: Record<VersionInfo['kind'], string> = {
  auto: '',
  named: '',
  restore: 'Restore',
  import: 'Import',
  'git-pull': 'Git pull',
  initial: 'Created',
};
