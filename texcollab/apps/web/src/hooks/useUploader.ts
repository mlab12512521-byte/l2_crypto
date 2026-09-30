import { useCallback, useRef, useState } from 'react';
import { uploadFile } from '../api/projects';

export interface UploadTask {
  id: number;
  path: string;
  progress: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
}

export interface PendingUpload {
  file: File;
  /** Path relative to the target folder, e.g. "figures/a.png". */
  relativePath: string;
}

const CONCURRENCY = 3;

/** Queue of file uploads with bounded concurrency and per-file progress. */
export function useUploader(projectId: string, onUploaded: () => void) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const nextId = useRef(1);
  const active = useRef(0);
  const queue = useRef<Array<{ id: number; parentId: string; item: PendingUpload }>>([]);

  const update = useCallback((id: number, patch: Partial<UploadTask>) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const pump = useCallback(() => {
    while (active.current < CONCURRENCY && queue.current.length > 0) {
      const job = queue.current.shift()!;
      active.current++;
      update(job.id, { status: 'uploading' });
      uploadFile(projectId, job.parentId, job.item.relativePath, job.item.file, (p) => update(job.id, { progress: p }))
        .then(() => {
          update(job.id, { status: 'done', progress: 1 });
          onUploaded();
        })
        .catch((err: Error) => update(job.id, { status: 'error', error: err.message }))
        .finally(() => {
          active.current--;
          pump();
        });
    }
  }, [projectId, onUploaded, update]);

  const enqueue = useCallback(
    (parentId: string, items: PendingUpload[]) => {
      const created: UploadTask[] = items.map((item) => {
        const id = nextId.current++;
        queue.current.push({ id, parentId, item });
        return { id, path: item.relativePath, progress: 0, status: 'queued' };
      });
      setTasks((ts) => [...ts.filter((t) => t.status !== 'done'), ...created]);
      pump();
    },
    [pump],
  );

  const clearFinished = useCallback(
    () => setTasks((ts) => ts.filter((t) => t.status === 'queued' || t.status === 'uploading')),
    [],
  );

  return { tasks, enqueue, clearFinished };
}

/** Collect files from a drop event, descending into dropped directories. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<PendingUpload[]> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ file, relativePath: file.name }));
  }
  const out: PendingUpload[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, relativePath: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in batches until an empty batch.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/** Files chosen with <input type="file" webkitdirectory> carry their relative path. */
export function filesFromInput(list: FileList): PendingUpload[] {
  return Array.from(list).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}
