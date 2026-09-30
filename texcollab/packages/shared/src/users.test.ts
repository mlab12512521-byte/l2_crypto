import { describe, expect, it } from 'vitest';
import { displayNameSchema, passwordSchema, usernameSchema } from './users.js';

describe('usernameSchema', () => {
  it.each(['alice', 'a.b-c_d', 'A1', 'x'.repeat(64)])('accepts %s', (u) => {
    expect(usernameSchema.safeParse(u).success).toBe(true);
  });
  it.each(['a', '.hidden', '-flag', 'a/b', 'a b', '../x', 'ünï', 'x'.repeat(65), 'a\u0000b'])('rejects %j', (u) => {
    expect(usernameSchema.safeParse(u).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('enforces length bounds', () => {
    expect(passwordSchema.safeParse('123456789').success).toBe(false);
    expect(passwordSchema.safeParse('1234567890').success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(257)).success).toBe(false);
  });
});

describe('displayNameSchema', () => {
  it('trims and rejects control characters', () => {
    expect(displayNameSchema.parse('  Alice  ')).toBe('Alice');
    expect(displayNameSchema.safeParse('Evil\u001b[31m').success).toBe(false);
    expect(displayNameSchema.safeParse('   ').success).toBe(false);
  });
});
