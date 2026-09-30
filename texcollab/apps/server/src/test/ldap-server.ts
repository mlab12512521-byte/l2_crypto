import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'ldapts';

export const LDAP_IMAGE = process.env.TEST_LDAP_IMAGE ?? 'texcollab/test-ldap:dev';

/** True if Docker and the test directory image are available (tests are skipped otherwise). */
export function ldapImageAvailable(): boolean {
  return spawnSync('docker', ['image', 'inspect', LDAP_IMAGE], { stdio: 'ignore' }).status === 0;
}

/**
 * Disposable OpenLDAP server (docker/test-ldap) with a fresh self-signed
 * certificate, listening on random localhost ports for ldap:// and ldaps://.
 */
export class TestLdapServer {
  readonly dir = mkdtempSync(path.join(tmpdir(), 'tc-ldap-'));
  readonly name = `tc-test-ldap-${process.pid}-${Date.now()}`;
  ldapPort = 0;
  ldapsPort = 0;

  get caCertificate(): string {
    return readFileSync(path.join(this.dir, 'cert.pem'), 'utf8');
  }

  async start(): Promise<void> {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        path.join(this.dir, 'key.pem'),
        '-out',
        path.join(this.dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    // slapd runs as root in the container but reads the key through a bind mount.
    chmodSync(this.dir, 0o755);
    chmodSync(path.join(this.dir, 'key.pem'), 0o644);
    execFileSync('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      this.name,
      '-p',
      '127.0.0.1::389',
      '-p',
      '127.0.0.1::636',
      '-v',
      `${this.dir}:/certs:ro`,
      LDAP_IMAGE,
    ]);
    const port = (p: number) =>
      Number(
        execFileSync('docker', ['port', this.name, `${p}/tcp`], { encoding: 'utf8' })
          .trim()
          .split(':')
          .pop(),
      );
    this.ldapPort = port(389);
    this.ldapsPort = port(636);
    for (let i = 0; i < 100; i++) {
      const c = new Client({ url: `ldap://127.0.0.1:${this.ldapPort}`, connectTimeout: 500, timeout: 1000 });
      try {
        await c.bind('cn=reader,dc=example,dc=org', 'reader-secret');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        await c.unbind().catch(() => undefined);
      }
    }
    throw new Error('test LDAP server did not start');
  }

  stop(): void {
    spawnSync('docker', ['rm', '-f', this.name], { stdio: 'ignore' });
    rmSync(this.dir, { recursive: true, force: true });
  }
}
