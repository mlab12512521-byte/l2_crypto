import type { GitRemoteInfo, VersionDiff, VersionInfo } from '@texcollab/shared';
import { ApiError, api } from './client';

export const historyApi = {
  list: (projectId: string) =>
    api.get<{ versions: VersionInfo[]; dirty: boolean }>(`/api/projects/${projectId}/versions`),
  save: (projectId: string, label: string) =>
    api.post<VersionInfo | null>(`/api/projects/${projectId}/versions`, { label }),
  diff: (projectId: string, to: string, from?: string) =>
    api.get<VersionDiff>(`/api/projects/${projectId}/diff`, { query: { to, from } }),
  restore: (projectId: string, versionId: string) =>
    api.post<VersionInfo | null>(`/api/projects/${projectId}/versions/${versionId}/restore`),
  downloadUrl: (projectId: string, versionId: string) =>
    `/api/projects/${projectId}/versions/${versionId}/download.zip`,
  fileUrl: (projectId: string, ref: string, path: string) =>
    `/api/projects/${projectId}/history/file?${new URLSearchParams({ ref, path })}`,
  /** Text content of a file at a version, null if it did not exist, 'binary' for binary files. */
  async fileText(projectId: string, ref: string, path: string): Promise<string | null | 'binary'> {
    const res = await fetch(historyApi.fileUrl(projectId, ref, path), { credentials: 'same-origin' });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, 'http_error', `Could not load ${path}`);
    if (res.headers.get('x-binary') !== null) return 'binary';
    return res.text();
  },

  git: (projectId: string) =>
    api.get<{
      remote: GitRemoteInfo | null;
      providers: Array<{ id: string; label: string; tokenHelp: string }>;
      provider?: string;
    }>(`/api/projects/${projectId}/git`),
  setRemote: (
    projectId: string,
    body: { url: string; branch: string; username?: string | null; token?: string | null },
  ) => api.put<GitRemoteInfo>(`/api/projects/${projectId}/git`, body),
  removeRemote: (projectId: string) => api.delete(`/api/projects/${projectId}/git`),
  push: (projectId: string) => api.post<{ pushed: string }>(`/api/projects/${projectId}/git/push`),
  pull: (projectId: string) =>
    api.post<{ result: 'up-to-date' | 'fast-forward' | 'merged'; conflicts?: string[] }>(
      `/api/projects/${projectId}/git/pull`,
    ),
};
