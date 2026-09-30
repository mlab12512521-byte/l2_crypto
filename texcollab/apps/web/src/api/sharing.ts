import type { MembersResponse, PublicUser } from '@texcollab/shared';
import { api } from './client';

export const sharingApi = {
  members: (projectId: string) => api.get<MembersResponse>(`/api/projects/${projectId}/members`),
  share: (projectId: string, body: { userId?: string; identifier?: string; role: 'editor' | 'viewer' }) =>
    api.post<{ kind: 'member' | 'invitation' }>(`/api/projects/${projectId}/members`, body),
  setRole: (projectId: string, userId: string, role: 'editor' | 'viewer') =>
    api.patch(`/api/projects/${projectId}/members/${userId}`, { role }),
  remove: (projectId: string, userId: string) => api.delete(`/api/projects/${projectId}/members/${userId}`),
  transfer: (projectId: string, userId: string) => api.post(`/api/projects/${projectId}/transfer`, { userId }),
  cancelInvitation: (projectId: string, id: string) => api.delete(`/api/projects/${projectId}/invitations/${id}`),
  searchUsers: (q: string) =>
    api.get<{ items: PublicUser[] }>('/api/users/search', { query: { q } }).then((r) => r.items),
};
