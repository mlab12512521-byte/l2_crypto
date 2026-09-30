import { z } from 'zod';
import type { PublicUser } from './users.js';

export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Numeric rank for comparing roles: owner > editor > viewer. */
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function roleAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export const COMPILERS = ['pdflatex', 'xelatex', 'lualatex'] as const;
export type Compiler = (typeof COMPILERS)[number];

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Project name is required')
  .max(200, 'Project name must be at most 200 characters')
  .regex(/^[^\p{Cc}]*$/u, 'Project name contains invalid characters');

/** Maximum UTF-8 byte length of a single file or folder name. */
export const MAX_NAME_BYTES = 255;
/** Maximum folder nesting depth inside a project. */
export const MAX_TREE_DEPTH = 32;

// Characters that are unsafe or non-portable in names: path separators, NUL and
// other control characters, and characters Windows forbids (so ZIP exports open
// everywhere).
const FORBIDDEN_NAME_CHARS = /[/\\\p{Cc}<>:"|?*]/u;

/**
 * Validate a single file/folder name (one path segment).
 * Returns an error message, or null if the name is acceptable.
 */
export function validateEntityName(name: string): string | null {
  if (name.length === 0) return 'Name must not be empty';
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return `Name must be at most ${MAX_NAME_BYTES} bytes`;
  if (name === '.' || name === '..') return 'Name must not be "." or ".."';
  if (FORBIDDEN_NAME_CHARS.test(name)) return 'Name must not contain / \\ < > : " | ? * or control characters';
  if (name !== name.trim()) return 'Name must not start or end with whitespace';
  if (name.endsWith('.')) return 'Name must not end with "."';
  return null;
}

export const entityNameSchema = z.string().superRefine((name, ctx) => {
  const err = validateEntityName(name);
  if (err) ctx.addIssue({ code: 'custom', message: err });
});

/**
 * Split and validate a relative path such as "figures/plot.png".
 * Rejects absolute paths, empty segments, "." and "..". Returns the segments.
 */
export function parseRelativePath(path: string): { segments: string[] } | { error: string } {
  if (path.length === 0) return { error: 'Path must not be empty' };
  if (path.length > 4096) return { error: 'Path is too long' };
  const normalised = path.replace(/\\/g, '/');
  if (normalised.startsWith('/')) return { error: 'Path must be relative' };
  const segments = normalised.split('/');
  if (segments.length > MAX_TREE_DEPTH + 1) return { error: 'Path is nested too deeply' };
  for (const s of segments) {
    const err = validateEntityName(s);
    if (err) return { error: `Invalid path segment "${s.slice(0, 50)}": ${err}` };
  }
  return { segments };
}

/**
 * Extensions opened as collaborative text documents. Anything else, or any
 * file that is not valid UTF-8 text, is stored as a binary file.
 */
export const TEXT_EXTENSIONS = new Set([
  'tex',
  'latex',
  'ltx',
  'sty',
  'cls',
  'clo',
  'cfg',
  'def',
  'fd',
  'dtx',
  'ins',
  'bib',
  'bst',
  'bbx',
  'cbx',
  'lbx',
  'dbx',
  'txt',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'dat',
  'tikz',
  'pgf',
  'mp',
  'asy',
  'gnuplot',
  'plt',
  'lua',
  'py',
  'r',
  'm',
  'sh',
  'json',
  'yaml',
  'yml',
  'xml',
  'svg',
  'html',
  'css',
  'js',
  'ist',
  'glo',
  'gls',
  'nlo',
  'bbl',
  'latexmkrc',
  'gitignore',
  'lco',
  'ldf',
]);

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name.startsWith('.') ? name.slice(1).toLowerCase() : '';
  return name.slice(idx + 1).toLowerCase();
}

export function isTextFileName(name: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

export type EntityKind = 'folder' | 'doc' | 'file';

export interface TreeEntity {
  id: string;
  parentId: string | null;
  kind: EntityKind;
  name: string;
  size: number;
  updatedAt: string;
}

export interface ProjectTree {
  rootId: string;
  entities: TreeEntity[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  role: ProjectRole;
  owner: PublicUser;
  createdAt: string;
  lastModifiedAt: string;
  lastModifiedBy: PublicUser | null;
  lastOpenedAt: string | null;
}

export interface ProjectDetails extends ProjectSummary {
  compiler: Compiler;
  mainFileId: string | null;
  rootFolderId: string;
}

export interface ProjectLimits {
  maxFileSizeBytes: number;
  maxProjectSizeBytes: number;
  maxEntitiesPerProject: number;
  maxTextFileSizeBytes: number;
}

export interface DocContent {
  text: string;
  contentHash: string;
}

/** Project-wide symbols for editor autocompletion. */
export interface ProjectSymbols {
  labels: Array<{ name: string; file: string }>;
  citations: Array<{ key: string; file: string; title?: string }>;
  /** All file paths, for \input, \include, \includegraphics, \bibliography. */
  files: string[];
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** One problem reported by LaTeX, BibTeX or Biber. */
export interface CompileDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** Project-relative path, or null when the location is unknown or outside the project. */
  file: string | null;
  /** Entity id of `file`, when it is a project document. */
  entityId: string | null;
  line: number | null;
  /** Extra context lines from the log (e.g. "l.12 \foo"). */
  context?: string;
  source: 'latex' | 'bibtex' | 'biber' | 'latexmk';
  /** Overfull/underfull boxes. */
  kind?: 'badbox';
}

export type CompileStatus = 'success' | 'failure' | 'timeout' | 'error';

export interface CompileResult {
  buildId: string;
  status: CompileStatus;
  message: string | null;
  durationMs: number;
  startedAt: string;
  engine: Compiler;
  /** Output files available for download (output.pdf, output.log, ...). */
  outputFiles: Array<{ name: string; size: number }>;
  diagnostics: CompileDiagnostic[];
}

export interface ProjectMember {
  user: PublicUser;
  role: ProjectRole;
  addedAt: string;
}

export interface ProjectInvitation {
  id: string;
  email: string;
  role: 'editor' | 'viewer';
  invitedBy: PublicUser | null;
  createdAt: string;
  expiresAt: string;
}

export interface MembersResponse {
  members: ProjectMember[];
  /** Only returned to the owner. */
  invitations: ProjectInvitation[];
}

export type VersionKind = 'auto' | 'named' | 'restore' | 'import' | 'git-pull' | 'initial';

export interface VersionInfo {
  id: string;
  commitSha: string;
  kind: VersionKind;
  label: string | null;
  createdAt: string;
  createdBy: PublicUser | null;
  contributors: PublicUser[];
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  status: ChangeStatus;
  path: string;
  /** Previous path for renames. */
  oldPath?: string;
  binary: boolean;
}

export interface VersionDiff {
  from: string | null;
  to: string;
  changes: FileChange[];
}

export interface GitRemoteInfo {
  url: string;
  branch: string;
  username: string | null;
  hasSecret: boolean;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
}
