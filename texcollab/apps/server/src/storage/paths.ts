import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * All on-disk locations derived from IDs go through here. Only validated
 * UUIDs are accepted, so no user-controlled string ever becomes a path.
 */
export class StoragePaths {
  constructor(readonly dataDir: string) {}

  private checkId(id: string): string {
    if (!UUID_RE.test(id)) throw new Error('invalid identifier for storage path');
    return id;
  }

  get blobsDir(): string {
    return path.join(this.dataDir, 'blobs');
  }

  get gitDir(): string {
    return path.join(this.dataDir, 'git');
  }

  /** Scratch space for uploads being processed (e.g. ZIP imports). */
  get importTmpDir(): string {
    return path.join(this.dataDir, 'tmp');
  }

  get buildsDir(): string {
    return path.join(this.dataDir, 'builds');
  }

  projectGitDir(projectId: string): string {
    return path.join(this.gitDir, `${this.checkId(projectId)}.git`);
  }

  projectBuildsDir(projectId: string): string {
    return path.join(this.buildsDir, this.checkId(projectId));
  }

  buildDir(projectId: string, buildId: string): string {
    return path.join(this.projectBuildsDir(projectId), this.checkId(buildId));
  }
}
