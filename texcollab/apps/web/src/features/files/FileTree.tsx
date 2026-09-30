import type { ProjectTree, TreeEntity } from '@texcollab/shared';
import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { projectsApi } from '../../api/projects';
import { filesFromDataTransfer, filesFromInput, type PendingUpload, type UploadTask } from '../../hooks/useUploader';
import { buildTree, iconFor, isWithin, type TreeNode } from './tree-model';

const DRAG_TYPE = 'application/x-texcollab-entity';

export interface FileTreeProps {
  projectId: string;
  tree: ProjectTree;
  readOnly: boolean;
  mainFileId: string | null;
  selectedId: string | null;
  onSelect: (entity: TreeEntity) => void;
  onChanged: () => void;
  onSetMain: (entity: TreeEntity) => void;
  onError: (message: string) => void;
  upload: (parentId: string, items: PendingUpload[]) => void;
  uploads: UploadTask[];
  onClearUploads: () => void;
}

type Pending = { kind: 'folder' | 'doc'; parentId: string } | null;

export function FileTree(props: FileTreeProps) {
  const { projectId, tree, readOnly, selectedId, onChanged, onError } = props;
  const nodes = useMemo(() => buildTree(tree.rootId, tree.entities), [tree]);
  const storageKey = `texcollab.tree.${projectId}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entity: TreeEntity } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {
      // Storage unavailable (private mode): expansion state is simply not remembered.
    }
  }, [expanded, storageKey]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const selected = tree.entities.find((e) => e.id === selectedId) ?? null;
  /** Folder that new items go into: the selected folder, the selected file's folder, or the root. */
  const targetFolderId = selected
    ? selected.kind === 'folder'
      ? selected.id
      : (selected.parentId ?? tree.rootId)
    : tree.rootId;

  const toggle = (id: string, open?: boolean) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (open ?? !n.has(id)) n.add(id);
      else n.delete(id);
      return n;
    });

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const startCreate = (kind: 'folder' | 'doc') => {
    if (targetFolderId !== tree.rootId) toggle(targetFolderId, true);
    setPending({ kind, parentId: targetFolderId });
  };

  const commitCreate = (name: string) => {
    const p = pending;
    setPending(null);
    if (!p || !name.trim()) return;
    void run(async () => {
      const e = await projectsApi.createEntity(projectId, { parentId: p.parentId, kind: p.kind, name: name.trim() });
      if (e.kind === 'doc') props.onSelect(e);
    });
  };

  const commitRename = (entity: TreeEntity, name: string) => {
    setRenamingId(null);
    if (!name.trim() || name === entity.name) return;
    void run(() => projectsApi.updateEntity(projectId, entity.id, { name: name.trim() }));
  };

  const remove = (entity: TreeEntity) => {
    const what = entity.kind === 'folder' ? `the folder "${entity.name}" and everything in it` : `"${entity.name}"`;
    if (!confirm(`Delete ${what}?`)) return;
    void run(() => projectsApi.deleteEntity(projectId, entity.id));
  };

  // ---- drag and drop: internal moves and external file drops
  const onDragOver = (e: DragEvent, folderId: string) => {
    if (readOnly) return;
    const internal = e.dataTransfer.types.includes(DRAG_TYPE);
    const external = e.dataTransfer.types.includes('Files');
    if (!internal && !external) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    setDropTarget(folderId);
  };

  const onDrop = async (e: DragEvent, folderId: string) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const movedId = e.dataTransfer.getData(DRAG_TYPE);
    if (movedId) {
      const moved = tree.entities.find((x) => x.id === movedId);
      if (!moved || moved.parentId === folderId) return;
      if (moved.kind === 'folder' && isWithin(tree.entities, folderId, moved.id)) {
        onError('A folder cannot be moved into itself');
        return;
      }
      void run(() => projectsApi.updateEntity(projectId, movedId, { parentId: folderId }));
      return;
    }
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) {
      if (folderId !== tree.rootId) toggle(folderId, true);
      props.upload(folderId, files);
    }
  };

  const onKeyDown = (e: KeyboardEvent, node: TreeNode) => {
    if (renamingId) return;
    if (e.key === 'F2' && !readOnly) {
      e.preventDefault();
      setRenamingId(node.id);
    } else if (e.key === 'Delete' && !readOnly) {
      e.preventDefault();
      remove(node);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (node.kind === 'folder') toggle(node.id);
      props.onSelect(node);
    } else if (e.key === 'ArrowRight' && node.kind === 'folder') {
      toggle(node.id, true);
    } else if (e.key === 'ArrowLeft' && node.kind === 'folder') {
      toggle(node.id, false);
    }
  };

  const renderNodes = (list: TreeNode[], depth: number, parentId: string) => (
    <>
      {pending && pending.parentId === parentId && (
        <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="tree-icon">{pending.kind === 'folder' ? '▸' : '·'}</span>
          <InlineName
            initial={pending.kind === 'doc' ? '.tex' : ''}
            placeholder={pending.kind === 'folder' ? 'Folder name' : 'File name'}
            selectBase
            onCommit={commitCreate}
            onCancel={() => setPending(null)}
          />
        </div>
      )}
      {list.map((node) => {
        const open = expanded.has(node.id);
        const isFolder = node.kind === 'folder';
        return (
          <div key={node.id} role="none">
            <div
              role="treeitem"
              aria-expanded={isFolder ? open : undefined}
              aria-selected={node.id === selectedId}
              className={[
                'tree-row',
                node.id === selectedId ? 'selected' : '',
                dropTarget === node.id ? 'drop-target' : '',
              ].join(' ')}
              style={{ paddingLeft: 8 + depth * 14 }}
              tabIndex={0}
              draggable={!readOnly && renamingId !== node.id}
              title={node.path}
              onClick={() => {
                if (isFolder) toggle(node.id);
                props.onSelect(node);
              }}
              onDoubleClick={() => !readOnly && !isFolder && setRenamingId(node.id)}
              onKeyDown={(e) => onKeyDown(e, node)}
              onContextMenu={(e) => {
                e.preventDefault();
                props.onSelect(node);
                setMenu({ x: e.clientX, y: e.clientY, entity: node });
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, node.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={isFolder ? (e) => onDragOver(e, node.id) : undefined}
              onDragLeave={isFolder ? () => setDropTarget(null) : undefined}
              onDrop={isFolder ? (e) => void onDrop(e, node.id) : undefined}
            >
              <span className={`tree-icon${isFolder ? ' tree-folder' : ''}`}>{iconFor(node, open)}</span>
              {renamingId === node.id ? (
                <InlineName
                  initial={node.name}
                  selectBase={!isFolder}
                  onCommit={(name) => commitRename(node, name)}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <span className="tree-name">{node.name}</span>
              )}
              {node.id === props.mainFileId && (
                <span className="tree-main" title="Main file (compiled)">
                  main
                </span>
              )}
            </div>
            {isFolder && open && (
              // ARIA tree pattern: children of a treeitem live in role="group" (not a form fieldset).
              // biome-ignore lint/a11y/useSemanticElements: ARIA tree group, see comment above
              <div role="group">{renderNodes(node.children, depth + 1, node.id)}</div>
            )}
          </div>
        );
      })}
    </>
  );

  return (
    <div className="file-tree">
      <div className="panel-toolbar" role="toolbar" aria-label="File actions">
        <span className="panel-title">Files</span>
        {!readOnly && (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              title="New file"
              onClick={() => startCreate('doc')}
            >
              + File
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              title="New folder"
              onClick={() => startCreate('folder')}
            >
              + Folder
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              title="Upload files"
              onClick={() => fileInput.current?.click()}
            >
              Upload
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              title="Upload a folder"
              onClick={() => dirInput.current?.click()}
            >
              Folder↑
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-label="Upload files"
              onChange={(e) => {
                if (e.target.files?.length) props.upload(targetFolderId, filesFromInput(e.target.files));
                e.target.value = '';
              }}
            />
            <input
              ref={dirInput}
              type="file"
              hidden
              aria-label="Upload folder"
              // Non-standard but universally supported attribute for directory selection.
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => {
                if (e.target.files?.length) props.upload(targetFolderId, filesFromInput(e.target.files));
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
      <div
        className={`tree${dropTarget === tree.rootId ? ' drop-target' : ''}`}
        role="tree"
        aria-label="Project files"
        onDragOver={(e) => onDragOver(e, tree.rootId)}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => void onDrop(e, tree.rootId)}
      >
        {renderNodes(nodes, 0, tree.rootId)}
        {nodes.length === 0 && !pending && (
          <div className="tree-empty muted">No files yet. Drop files here to upload.</div>
        )}
      </div>
      {props.uploads.length > 0 && <UploadList tasks={props.uploads} onClear={props.onClearUploads} />}
      {menu && (
        <ul className="context-menu" style={{ left: menu.x, top: menu.y }} aria-label="File actions">
          {menu.entity.kind !== 'folder' && (
            <li>
              <a href={projectsApi.contentUrl(projectId, menu.entity.id)} download>
                Download
              </a>
            </li>
          )}
          {!readOnly && (
            <>
              {menu.entity.kind === 'doc' &&
                /\.tex$/i.test(menu.entity.name) &&
                menu.entity.id !== props.mainFileId && (
                  <li>
                    <button type="button" onClick={() => props.onSetMain(menu.entity)}>
                      Set as main file
                    </button>
                  </li>
                )}
              <li>
                <button type="button" onClick={() => setRenamingId(menu.entity.id)}>
                  Rename
                </button>
              </li>
              <li>
                <button type="button" className="danger" onClick={() => remove(menu.entity)}>
                  Delete
                </button>
              </li>
            </>
          )}
        </ul>
      )}
    </div>
  );
}

function InlineName({
  initial,
  placeholder,
  selectBase,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  selectBase?: boolean;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the name without its extension, like desktop file managers.
    const dot = initial.lastIndexOf('.');
    if (selectBase && dot > 0) input.setSelectionRange(0, dot);
    else if (selectBase && dot === 0) input.setSelectionRange(0, 0);
    else input.select();
  }, [initial, selectBase]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? '');
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="tree-input"
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={placeholder ?? 'Name'}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

function UploadList({ tasks, onClear }: { tasks: UploadTask[]; onClear: () => void }) {
  const busy = tasks.some((t) => t.status === 'queued' || t.status === 'uploading');
  return (
    <div className="upload-list" aria-live="polite">
      <div className="upload-head">
        <span>{busy ? 'Uploading…' : 'Uploads finished'}</span>
        {!busy && (
          <button type="button" className="btn btn-ghost btn-small" onClick={onClear}>
            Dismiss
          </button>
        )}
      </div>
      {tasks.map((t) => (
        <div key={t.id} className={`upload-item upload-${t.status}`} title={t.error ?? t.path}>
          <span className="upload-name">{t.path}</span>
          {t.status === 'error' ? (
            <span className="upload-error">{t.error}</span>
          ) : (
            <progress max={1} value={t.status === 'done' ? 1 : t.progress} />
          )}
        </div>
      ))}
    </div>
  );
}
