import {
  type CompileResult,
  type Compiler,
  CSRF_HEADER,
  type DocContent,
  type ProjectDetails,
  type ProjectSummary,
  type ProjectTree,
  type TreeEntity,
} from '@texcollab/shared';
import { ApiError, api, getCsrfToken } from './client';

export type ProjectFilter = 'all' | 'owned' | 'shared';
export type ProjectSort = 'lastModified' | 'lastOpened' | 'name' | 'created';

export const projectsApi = {
  list: (q: { filter: ProjectFilter; q?: string; sort: ProjectSort }) =>
    api.get<{ items: ProjectSummary[] }>('/api/projects', { query: q }).then((r) => r.items),
  create: (name: string, template: 'article' | 'blank') =>
    api.post<ProjectDetails>('/api/projects', { name, template }),
  get: (id: string) => api.get<ProjectDetails>(`/api/projects/${id}`),
  update: (id: string, patch: Partial<{ name: string; compiler: Compiler; mainFileId: string | null }>) =>
    api.patch<ProjectDetails>(`/api/projects/${id}`, patch),
  remove: (id: string) => api.delete<void>(`/api/projects/${id}`),
  exportUrl: (id: string) => `/api/projects/${id}/export.zip`,

  tree: (id: string) => api.get<ProjectTree>(`/api/projects/${id}/tree`),
  createEntity: (id: string, body: { parentId: string; kind: 'folder' | 'doc'; name: string; content?: string }) =>
    api.post<TreeEntity>(`/api/projects/${id}/entities`, body),
  updateEntity: (id: string, eid: string, body: { name?: string; parentId?: string }) =>
    api.patch<TreeEntity>(`/api/projects/${id}/entities/${eid}`, body),
  deleteEntity: (id: string, eid: string) => api.delete<void>(`/api/projects/${id}/entities/${eid}`),
  contentUrl: (id: string, eid: string, inline = false) =>
    `/api/projects/${id}/entities/${eid}/content${inline ? '?inline=1' : ''}`,
  readText: (id: string, eid: string) => api.get<DocContent>(`/api/projects/${id}/entities/${eid}/text`),
  writeText: (id: string, eid: string, text: string, baseHash: string | null) =>
    api.put<DocContent>(`/api/projects/${id}/entities/${eid}/text`, { text, baseHash }),

  compile: (id: string, draft = false) => api.post<CompileResult>(`/api/projects/${id}/compile`, { draft }),
  latestBuild: (id: string) =>
    api.get<{ build: CompileResult | null; running: boolean }>(`/api/projects/${id}/builds/latest`),
  buildFileUrl: (id: string, buildId: string, file: string, download = false) =>
    `/api/projects/${id}/builds/${buildId}/${file}${download ? '?download=1' : ''}`,
  syncToPdf: (id: string, buildId: string, file: string, line: number) =>
    api.get<{ boxes: Array<{ page: number; x: number; y: number; width: number; height: number }> }>(
      `/api/projects/${id}/builds/${buildId}/synctex/code`,
      { query: { file, line } },
    ),
  syncToCode: (id: string, buildId: string, page: number, x: number, y: number) =>
    api.get<{ location: { file: string; line: number; entityId: string | null } | null }>(
      `/api/projects/${id}/builds/${buildId}/synctex/pdf`,
      { query: { page, x: x.toFixed(2), y: y.toFixed(2) } },
    ),
};

/**
 * Upload a raw file with progress reporting (fetch has no upload progress).
 * Resolves with the parsed JSON response; rejects with ApiError.
 */
export function uploadWithProgress<T>(
  url: string,
  body: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader(CSRF_HEADER, getCsrfToken() ?? 'none');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T);
      } else {
        const err = (xhr.response as { error?: { code: string; message: string } } | null)?.error;
        reject(new ApiError(xhr.status, err?.code ?? 'upload_failed', err?.message ?? `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Network error during upload'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}

export function uploadFile(
  projectId: string,
  parentId: string,
  relativePath: string,
  file: Blob,
  onProgress?: (fraction: number) => void,
) {
  const qs = new URLSearchParams({ parentId, path: relativePath });
  return uploadWithProgress<TreeEntity & { replaced: boolean }>(
    `/api/projects/${projectId}/upload?${qs}`,
    file,
    onProgress,
  );
}

export function importProject(name: string, zip: Blob, onProgress?: (f: number) => void) {
  return uploadWithProgress<ProjectDetails>(`/api/projects/import?${new URLSearchParams({ name })}`, zip, onProgress);
}
