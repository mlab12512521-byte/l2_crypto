import { type Algorithm, hash, verify } from '@node-rs/argon2';

/** `Algorithm.Argon2id`; the enum is a const enum, which isolated modules cannot import. */
const ARGON2ID = 2 as Algorithm;

/**
 * Argon2id with OWASP-recommended minimum parameters
 * (19 MiB memory, 2 iterations, 1 lane). Parameters are encoded in the hash
 * string, so they can be raised later without breaking existing hashes.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Malformed hash in the database: treat as mismatch, never throw to the client.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn roughly the same time as a real verification, used when the user does
 * not exist so response timing does not reveal valid usernames.
 */
export async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('texcollab-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}
