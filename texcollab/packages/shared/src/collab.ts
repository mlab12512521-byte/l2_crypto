/** Collaboration protocol constants shared by the server hub and the SPA. */

export const DOC_PREFIX = 'doc:';
export const PROJECT_PREFIX = 'project:';

export const docChannel = (entityId: string) => `${DOC_PREFIX}${entityId}`;
export const projectChannel = (projectId: string) => `${PROJECT_PREFIX}${projectId}`;

/** Identity attached by the server to every awareness state (clients cannot forge it). */
export interface AwarenessUser {
  id: string;
  name: string;
  color: string;
  colorLight: string;
}

/** Server → client notifications on the project channel. */
export type ProjectEvent =
  | { type: 'tree' }
  | { type: 'project' }
  | { type: 'members' }
  | { type: 'compiled'; buildId: string; status: string; by: string | null }
  | { type: 'versions' };

const PALETTE = [
  '#d9480f',
  '#2b8a3e',
  '#1971c2',
  '#9c36b5',
  '#e8590c',
  '#0c8599',
  '#c2255c',
  '#5f3dc4',
  '#66a80f',
  '#f08c00',
  '#364fc7',
  '#a61e4d',
];

/** Stable, distinct colour per user id. */
export function userColor(userId: string): { color: string; colorLight: string } {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  const color = PALETTE[h % PALETTE.length]!;
  return { color, colorLight: `${color}33` };
}
