import type { TreeEntity } from '@texcollab/shared';

export interface TreeNode extends TreeEntity {
  children: TreeNode[];
  path: string;
}

/** Build a sorted nested tree (folders first, then natural name order). */
export function buildTree(rootId: string, entities: TreeEntity[]): TreeNode[] {
  const byParent = new Map<string, TreeEntity[]>();
  for (const e of entities) {
    const key = e.parentId ?? '';
    const list = byParent.get(key) ?? [];
    list.push(e);
    byParent.set(key, list);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const build = (parentId: string, prefix: string, depth: number): TreeNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) =>
        (a.kind === 'folder') !== (b.kind === 'folder')
          ? a.kind === 'folder'
            ? -1
            : 1
          : collator.compare(a.name, b.name),
      )
      .map((e) => {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        return { ...e, path, children: e.kind === 'folder' && depth < 64 ? build(e.id, path, depth + 1) : [] };
      });
  return build(rootId, '', 0);
}

/** Map entity id → relative path. */
export function pathIndex(nodes: TreeNode[], out = new Map<string, string>()): Map<string, string> {
  for (const n of nodes) {
    out.set(n.id, n.path);
    pathIndex(n.children, out);
  }
  return out;
}

/** True if `candidateId` is `ancestorId` or lies below it. */
export function isWithin(entities: TreeEntity[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(entities.map((e) => [e.id, e]));
  let cur: string | null | undefined = candidateId;
  for (let i = 0; cur && i < 100; i++) {
    if (cur === ancestorId) return true;
    cur = byId.get(cur)?.parentId;
  }
  return false;
}

const ICONS: Record<string, string> = {
  tex: '𝑇',
  bib: '❝',
  sty: '§',
  cls: '§',
  png: '▣',
  jpg: '▣',
  jpeg: '▣',
  gif: '▣',
  pdf: '⎙',
  svg: '▣',
  eps: '▣',
};

export function iconFor(node: Pick<TreeEntity, 'kind' | 'name'>, open = false): string {
  if (node.kind === 'folder') return open ? '▾' : '▸';
  const ext = node.name.includes('.') ? node.name.slice(node.name.lastIndexOf('.') + 1).toLowerCase() : '';
  return ICONS[ext] ?? '·';
}
