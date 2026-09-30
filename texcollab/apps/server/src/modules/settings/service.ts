import { z } from 'zod';
import type { Db } from '../../db/index.js';

/**
 * Administrator-editable settings stored in `system_settings` as JSON.
 * Every key has a Zod schema with defaults, so a missing or partially
 * written row always yields a complete, valid value.
 */

export const settingSchemas = {
  registration: z
    .object({
      /** Allow anyone who can reach the site to create a local account. */
      enabled: z.boolean().default(false),
    })
    .prefault({}),
  projectLimits: z
    .object({
      /** Largest single uploaded file. */
      maxFileSizeMb: z.number().int().min(1).max(10_240).default(100),
      /** Largest text file opened in the editor; bigger text files are stored as binary. */
      maxTextFileSizeMb: z.number().int().min(1).max(50).default(5),
      /** Total size of all files in one project. */
      maxProjectSizeMb: z.number().int().min(1).max(102_400).default(1024),
      maxEntitiesPerProject: z.number().int().min(10).max(100_000).default(5000),
    })
    .prefault({}),
  compileLimits: z
    .object({
      /** Wall-clock limit for one compilation (all passes). Workers enforce their own maximum too. */
      timeoutSeconds: z.number().int().min(10).max(1800).default(120),
      memoryMb: z.number().int().min(256).max(65_536).default(2048),
      cpus: z.number().min(0.25).max(64).default(2),
      /** How many past builds (PDF + logs) to keep per project. */
      keepBuilds: z.number().int().min(1).max(50).default(3),
    })
    .prefault({}),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingSchemas, key);
}

export class SettingsService {
  constructor(private readonly db: Db) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const row = await this.db.selectFrom('system_settings').select('value').where('key', '=', key).executeTakeFirst();
    const parsed = settingSchemas[key].safeParse(row?.value ?? {});
    // A stored value that no longer validates (e.g. after an upgrade) falls back to defaults.
    return (parsed.success ? parsed.data : settingSchemas[key].parse({})) as SettingValue<K>;
  }

  async set<K extends SettingKey>(key: K, value: unknown, updatedBy: string | null): Promise<SettingValue<K>> {
    const parsed = settingSchemas[key].parse(value) as SettingValue<K>;
    const json = JSON.stringify(parsed);
    await this.db
      .insertInto('system_settings')
      .values({ key, value: json, updated_by: updatedBy })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: json, updated_by: updatedBy, updated_at: new Date() }))
      .execute();
    return parsed;
  }
}

export function limitsInBytes(l: SettingValue<'projectLimits'>) {
  const MB = 1024 * 1024;
  return {
    maxFileSizeBytes: l.maxFileSizeMb * MB,
    maxTextFileSizeBytes: l.maxTextFileSizeMb * MB,
    maxProjectSizeBytes: l.maxProjectSizeMb * MB,
    maxEntitiesPerProject: l.maxEntitiesPerProject,
  };
}
