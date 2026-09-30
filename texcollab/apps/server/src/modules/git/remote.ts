import { lookup } from 'node:dns/promises';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type { GitRemoteInfo } from '@texcollab/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { SecretBox } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import type { FileService } from '../files/service.js';
import type { SettingsService } from '../settings/service.js';
import { GitError, type GitRepo } from './git.js';
import type { VersionService } from './versions.js';

/**
 * Hosting providers. All use plain HTTPS Git with a personal access token as
 * the password, so one generic implementation serves them; providers only
 * contribute defaults and help text. Add new providers here.
 */
export interface GitRemoteProvider {
  id: string;
  label: string;
  matches(host: string): boolean;
  /** Username to use with a token when the user leaves it empty. */
  defaultUsername: string;
  tokenHelp: string;
}

export const PROVIDERS: GitRemoteProvider[] = [
  {
    id: 'github',
    label: 'GitHub',
    matches: (h) => h === 'github.com',
    defaultUsername: 'x-access-token',
    tokenHelp: 'Use a fine-grained personal access token with "Contents: read and write" for the repository.',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    matches: (h) => h === 'gitlab.com' || h.startsWith('gitlab.'),
    defaultUsername: 'oauth2',
    tokenHelp: 'Use a project or personal access token with the read_repository and write_repository scopes.',
  },
  {
    id: 'gitea',
    label: 'Gitea / Forgejo',
    matches: (h) => h.startsWith('gitea.') || h === 'codeberg.org' || h.startsWith('forgejo.'),
    defaultUsername: 'git',
    tokenHelp: 'Use an access token with repository read/write permission; the username can be your account name.',
  },
  {
    id: 'generic',
    label: 'Other Git server (HTTPS)',
    matches: () => true,
    defaultUsername: 'git',
    tokenHelp: 'Use the username and password or access token the server accepts for HTTPS Git.',
  },
];

export function providerFor(host: string): GitRemoteProvider {
  return PROVIDERS.find((p) => p.matches(host)) ?? PROVIDERS[PROVIDERS.length - 1]!;
}

const BRANCH_RE = /^(?!-)(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/;

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/**
 * Validate a remote URL: https only, no embedded credentials, and (to
 * prevent the server being used to reach internal services) no private,
 * loopback or link-local destinations unless the host is explicitly
 * allow-listed by an administrator.
 */
export async function validateRemoteUrl(raw: string, allowedHosts: string[]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('Enter a valid repository URL (https://…)');
  }
  if (url.protocol !== 'https:') throw badRequest('Only https:// repository URLs are supported');
  if (url.username || url.password)
    throw badRequest('Do not put credentials in the URL; use the username and token fields');
  if (url.search || url.hash) throw badRequest('The repository URL must not contain a query or fragment');
  // IPv6 literals keep their brackets in URL.hostname.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowListed = allowedHosts.includes(host);
  if (allowedHosts.length > 0 && !allowListed) {
    throw badRequest(`Remote host ${host} is not allowed by the administrator`);
  }
  if (!allowListed) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw badRequest('Remote host is not allowed');
    }
    const addresses = isIP(host)
      ? [host]
      : await lookup(host, { all: true }).then(
          (r) => r.map((x) => x.address),
          () => [],
        );
    if (addresses.length === 0) throw badRequest(`Cannot resolve ${host}`);
    if (addresses.some(isPrivateAddress)) {
      throw badRequest('Remote host resolves to a private address; ask an administrator to allow-list it');
    }
  }
  return url;
}

export class RemoteService {
  private readonly box: SecretBox;
  private askpass: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly versions: VersionService,
    private readonly files: FileService,
    private readonly settings: SettingsService,
    appSecret: string,
    private readonly tmpDir: string,
    private readonly log: Logger,
    private readonly caBundle: string | null = null,
  ) {
    this.box = new SecretBox(appSecret, 'git-remote');
  }

  /** A fixed helper script: it prints credentials from environment variables, holding no secrets itself. */
  private async askpassScript(): Promise<string> {
    if (this.askpass) return this.askpass;
    await mkdir(this.tmpDir, { recursive: true });
    const file = path.join(this.tmpDir, 'git-askpass.sh');
    await writeFile(
      file,
      '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' "$TEXCOLLAB_GIT_USERNAME" ;;\n  *) printf \'%s\\n\' "$TEXCOLLAB_GIT_PASSWORD" ;;\nesac\n',
      { mode: 0o700 },
    );
    await chmod(file, 0o700);
    this.askpass = file;
    return file;
  }

  async get(projectId: string): Promise<GitRemoteInfo | null> {
    const r = await this.db
      .selectFrom('git_remotes')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!r) return null;
    return {
      url: r.url,
      branch: r.branch,
      username: r.username,
      hasSecret: r.secret_encrypted !== null,
      lastPushAt: r.last_push_at?.toISOString() ?? null,
      lastPullAt: r.last_pull_at?.toISOString() ?? null,
      lastError: r.last_error,
    };
  }

  /**
   * Configure the remote. `token` undefined keeps the stored secret, null
   * removes it. The secret is never returned by the API.
   */
  async set(
    projectId: string,
    userId: string,
    input: { url: string; branch: string; username?: string | null; token?: string | null },
  ): Promise<GitRemoteInfo> {
    const { allowedHosts } = await this.settings.get('git');
    const url = await validateRemoteUrl(input.url, allowedHosts);
    if (!BRANCH_RE.test(input.branch)) throw badRequest('Invalid branch name');
    const existing = await this.db
      .selectFrom('git_remotes')
      .select('secret_encrypted')
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    const secret =
      input.token === undefined
        ? (existing?.secret_encrypted ?? null)
        : input.token
          ? this.box.encrypt(input.token)
          : null;
    const values = {
      url: url.toString(),
      branch: input.branch,
      username: input.username?.trim() || null,
      secret_encrypted: secret,
      updated_by: userId,
      updated_at: new Date(),
      last_error: null,
    };
    await this.db
      .insertInto('git_remotes')
      .values({ project_id: projectId, ...values })
      .onConflict((oc) => oc.column('project_id').doUpdateSet(values))
      .execute();
    return (await this.get(projectId))!;
  }

  async remove(projectId: string): Promise<void> {
    await this.db.deleteFrom('git_remotes').where('project_id', '=', projectId).execute();
  }

  private async credentials(projectId: string) {
    const r = await this.db
      .selectFrom('git_remotes')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!r) throw notFound('No remote repository is configured for this project');
    const { allowedHosts } = await this.settings.get('git');
    // Re-validate at use time: DNS may have changed since configuration.
    const url = await validateRemoteUrl(r.url, allowedHosts);
    const env: Record<string, string> = {};
    if (this.caBundle) env.GIT_SSL_CAINFO = this.caBundle;
    if (r.secret_encrypted) {
      env.GIT_ASKPASS = await this.askpassScript();
      env.TEXCOLLAB_GIT_USERNAME = r.username || providerFor(url.hostname).defaultUsername;
      env.TEXCOLLAB_GIT_PASSWORD = this.box.decrypt(r.secret_encrypted);
    }
    return { url: url.toString(), branch: r.branch, env };
  }

  /** Remote-access flags: no redirects (SSRF), bounded time, low-speed abort. */
  private remoteArgs(): string[] {
    return ['-c', 'http.followRedirects=false', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60'];
  }

  private async fail(projectId: string, err: unknown): Promise<never> {
    const message =
      err instanceof GitError
        ? friendlyGitError(err.stderr)
        : err instanceof AppError
          ? err.message
          : 'The remote operation failed';
    await this.db
      .updateTable('git_remotes')
      .set({ last_error: message.slice(0, 500) })
      .where('project_id', '=', projectId)
      .execute();
    if (err instanceof AppError) throw err;
    this.log.warn(
      { projectId, err: err instanceof GitError ? err.stderr.slice(0, 500) : String(err) },
      'git remote operation failed',
    );
    throw new AppError(502, 'git_remote_failed', message);
  }

  /** Push the project history (after saving a version of the current state). */
  async push(projectId: string, userId: string): Promise<{ pushed: string }> {
    const creds = await this.credentials(projectId);
    await this.versions.createVersion(projectId, { kind: 'auto', userId });
    return this.versions.withLock(projectId, async () => {
      const repo = this.versions.repo(projectId);
      const head = await repo.resolve('refs/heads/main');
      if (!head) throw badRequest('Nothing to push yet');
      try {
        await repo.run(
          [...this.remoteArgs(), 'push', '--porcelain', creds.url, `refs/heads/main:refs/heads/${creds.branch}`],
          {
            env: creds.env,
            timeoutMs: 300_000,
          },
        );
      } catch (err) {
        if (err instanceof GitError && /rejected|non-fast-forward|fetch first/.test(err.stderr)) {
          await this.fail(
            projectId,
            conflict('The remote repository has changes that are not in this project. Pull first, then push.'),
          );
        }
        await this.fail(projectId, err);
      }
      await this.db
        .updateTable('git_remotes')
        .set({ last_push_at: new Date(), last_error: null })
        .where('project_id', '=', projectId)
        .execute();
      return { pushed: head };
    });
  }

  /**
   * Pull: fetch the remote branch and bring its changes into the project.
   * Fast-forwards and clean merges are applied; conflicting changes are
   * reported and nothing is modified.
   */
  async pull(
    projectId: string,
    userId: string,
  ): Promise<{ result: 'up-to-date' | 'fast-forward' | 'merged'; conflicts?: string[] }> {
    const creds = await this.credentials(projectId);
    await this.versions.createVersion(projectId, { kind: 'auto', userId });
    return this.versions.withLock(projectId, async () => {
      const repo = this.versions.repo(projectId);
      await repo.init();
      const remoteRef = 'refs/texcollab/remote';
      try {
        await repo.run(
          [
            ...this.remoteArgs(),
            'fetch',
            '--no-tags',
            '--quiet',
            creds.url,
            `+refs/heads/${creds.branch}:${remoteRef}`,
          ],
          {
            env: creds.env,
            timeoutMs: 300_000,
          },
        );
      } catch (err) {
        await this.fail(projectId, err);
      }
      const remote = (await repo.resolve(remoteRef))!;
      const local = await repo.resolve('refs/heads/main');
      let target: string;
      let result: 'up-to-date' | 'fast-forward' | 'merged';
      if (local && (remote === local || (await repo.isAncestor(remote, local)))) {
        await this.touchPull(projectId);
        return { result: 'up-to-date' };
      }
      if (!local || (await repo.isAncestor(local, remote))) {
        target = remote;
        result = 'fast-forward';
      } else {
        const merge = await repo.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', local, remote], {
          okCodes: [1],
        });
        const lines = merge.stdout.toString('utf8').split('\n').filter(Boolean);
        if (merge.code === 1) {
          const conflicts = lines.slice(1);
          await this.db
            .updateTable('git_remotes')
            .set({ last_error: `Conflicting changes in: ${conflicts.join(', ').slice(0, 400)}` })
            .where('project_id', '=', projectId)
            .execute();
          return { result: 'merged', conflicts };
        }
        const tree = lines[0]!;
        target = (
          await repo.text(['commit-tree', tree, '-p', local, '-p', remote, '-m', `Merge changes from ${creds.branch}`])
        ).trim();
        result = 'merged';
      }
      // Validate and apply the new content before moving `main`.
      const files = await this.versions.filesOf(projectId, target);
      await this.files.applyFiles(projectId, files, userId);
      await repo.run(['update-ref', 'refs/heads/main', target, ...(local ? [local] : [])]);
      await this.db
        .insertInto('versions')
        .values({
          project_id: projectId,
          commit_sha: target,
          kind: 'git-pull',
          label: `Pulled from ${creds.branch}`,
          created_by: userId,
          contributors: [userId],
        })
        .execute();
      // The applied changes are part of this version already.
      await this.db.deleteFrom('project_changes').where('project_id', '=', projectId).execute();
      await this.touchPull(projectId);
      return { result };
    });
  }

  private async touchPull(projectId: string) {
    await this.db
      .updateTable('git_remotes')
      .set({ last_pull_at: new Date(), last_error: null })
      .where('project_id', '=', projectId)
      .execute();
  }
}

/** Turn git's stderr into a message fit for users, without leaking credentials. */
export function friendlyGitError(stderr: string): string {
  if (/Authentication failed|403|401|could not read Username|invalid credentials/i.test(stderr)) {
    return 'The remote rejected the credentials. Check the username and access token.';
  }
  if (/not found|does not appear to be a git repository|404/i.test(stderr))
    return 'Repository not found (check the URL and access rights).';
  if (/couldn't find remote ref|remote ref does not exist/i.test(stderr))
    return 'The branch does not exist on the remote.';
  if (/Could not resolve host|Connection refused|timed out|Failed to connect/i.test(stderr))
    return 'Could not connect to the remote server.';
  if (/redirect/i.test(stderr))
    return 'The remote answered with a redirect, which is not followed. Use the final repository URL.';
  return 'The remote operation failed.';
}

export type { GitRepo };
