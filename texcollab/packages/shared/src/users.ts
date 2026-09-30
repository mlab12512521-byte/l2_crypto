import { z } from 'zod';

/**
 * Account-related validation rules shared by the API and the SPA.
 * The server is authoritative; the SPA reuses these for early feedback.
 */

export const PASSWORD_MIN_LENGTH = 10;
/** Upper bound protects the password hasher from very large inputs. */
export const PASSWORD_MAX_LENGTH = 256;

export const usernameSchema = z
  .string()
  .trim()
  .min(2, 'Username must be at least 2 characters')
  .max(64, 'Username must be at most 64 characters')
  // Conservative character set that is also valid for LDAP uid / sAMAccountName.
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Username may contain letters, digits, ".", "_" and "-"');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name is required')
  .max(100, 'Display name must be at most 100 characters')
  // No control characters (they could confuse logs and UIs).
  .regex(/^[^\p{Cc}]*$/u, 'Display name contains invalid characters');

export const emailSchema = z.string().trim().max(254).email('Invalid e-mail address');

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export type AuthSource = 'local' | 'ldap';

/** The authenticated user's own view of their account. */
export interface CurrentUser {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  authSource: AuthSource;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface MeResponse {
  user: CurrentUser;
  csrfToken: string;
}

/** Account details as seen by administrators. */
export interface AdminUser extends CurrentUser {
  isDisabled: boolean;
  lockedUntil: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Minimal public profile shown to other users (sharing, presence). */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
}
