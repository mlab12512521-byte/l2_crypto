import { FileService } from './service.js';

/** One file of a materialised project, addressed by its validated relative path. */
export type SnapshotFile =
  | { path: string; kind: 'doc'; entityId: string; text: string }
  | { path: string; kind: 'file'; entityId: string; blobHash: string; size: number };

export interface ProjectSnapshot {
  files: SnapshotFile[];
  /** Folders (including empty ones), as relative paths. */
  folders: string[];
}

/**
 * Materialise the current project state: every document's latest text
 * (including unsaved collaborative edits, via the doc writer) and every
 * binary file's blob reference. Used by compilation, ZIP export and history.
 */
export async function snapshotProject(files: FileService, projectId: string): Promise<ProjectSnapshot> {
  const rows = await files.entities(projectId);
  const paths = FileService.paths(rows);
  const out: ProjectSnapshot = { files: [], folders: [] };
  for (const r of rows) {
    const path = paths.get(r.id);
    if (path === undefined) continue; // root
    if (r.kind === 'folder') {
      out.folders.push(path);
    } else if (r.kind === 'doc') {
      const c = await files.docs.read(r.id);
      out.files.push({ path, kind: 'doc', entityId: r.id, text: c?.text ?? '' });
    } else {
      out.files.push({ path, kind: 'file', entityId: r.id, blobHash: r.blob_hash!, size: Number(r.size) });
    }
  }
  out.files.sort((a, b) => a.path.localeCompare(b.path));
  out.folders.sort();
  return out;
}
