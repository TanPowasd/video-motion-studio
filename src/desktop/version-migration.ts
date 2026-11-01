import path from 'node:path';
import { access, mkdir, readFile } from 'node:fs/promises';
import { gt, lte, valid as validVersion } from 'semver';
import { z } from 'zod';
import { atomicWrite, json } from '../service/project.js';
import type { ProfileKind } from './profile.js';

/**
 * One-time profile migrations when a different app version starts on the same profile
 * (installer upgrade-over-install, a new portable ZIP with a copied profile, or dev builds).
 * The last version that ran is recorded in `<userData>/install-state.json`.
 */
export interface ProfileMigrationContext {
  userData: string;
  previousVersion?: string;
  currentVersion: string;
}
export interface ProfileMigration {
  /** Stable id; recorded once it succeeded so it never runs twice. */
  id: string;
  /** First app version that needs it; runs when upgrading from an older version. */
  introducedIn: string;
  run(context: ProfileMigrationContext): Promise<void> | void;
}
/**
 * Registered migrations, oldest first. Add an entry when a release changes the shape of
 * settings.json, recent-projects.json or anything else under the profile.
 */
export const profileMigrations: readonly ProfileMigration[] = [];

export const INSTALL_STATE_FILE = 'install-state.json';
const stateSchema = z.object({
  version: z.literal(1),
  lastVersion: z.string(),
  previousVersion: z.string().optional(),
  kind: z.string().optional(),
  updatedAt: z.string(),
  migrations: z.array(z.string()),
});
export type InstallState = z.infer<typeof stateSchema>;

const valid = (version: string | undefined) =>
  version !== undefined && validVersion(version) !== null;

/**
 * Migrations to run. `previous` undefined with an existing profile (settings or recent
 * projects written by a version before this hook) counts as upgrading from 0.0.0; a brand
 * new profile has nothing to migrate. Downgrades and unparsable versions run nothing.
 */
export function pendingMigrations(
  previous: string | undefined,
  current: string,
  migrations: readonly ProfileMigration[],
  done: readonly string[],
  existingProfile: boolean,
) {
  if (!valid(current)) return [];
  const from = previous ?? (existingProfile ? '0.0.0' : undefined);
  if (from === undefined || !valid(from) || lte(current, from)) return [];
  return migrations.filter(
    (migration) =>
      !done.includes(migration.id) &&
      valid(migration.introducedIn) &&
      gt(migration.introducedIn, from) &&
      lte(migration.introducedIn, current),
  );
}

export async function readInstallState(userData: string): Promise<InstallState | undefined> {
  try {
    return stateSchema.parse(
      JSON.parse(await readFile(path.join(userData, INSTALL_STATE_FILE), 'utf8')),
    );
  } catch {
    return undefined;
  }
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

export interface MigrationOutcome {
  previousVersion?: string;
  currentVersion: string;
  changed: boolean;
  ran: string[];
  failed: { id: string; message: string }[];
}

/**
 * Runs pending migrations and records the current version. A failing migration is
 * reported and retried on the next launch; it never blocks startup.
 */
export async function runVersionMigration(
  userData: string,
  currentVersion: string,
  options: {
    kind?: ProfileKind;
    migrations?: readonly ProfileMigration[];
    now?: () => Date;
  } = {},
): Promise<MigrationOutcome> {
  const migrations = options.migrations ?? profileMigrations,
    state = await readInstallState(userData),
    previousVersion = state?.lastVersion,
    done = [...(state?.migrations ?? [])];
  const existingProfile =
    state !== undefined ||
    (await exists(path.join(userData, 'settings.json'))) ||
    (await exists(path.join(userData, 'recent-projects.json')));
  const outcome: MigrationOutcome = {
    previousVersion,
    currentVersion,
    changed: previousVersion !== currentVersion,
    ran: [],
    failed: [],
  };
  if (state && !outcome.changed && state.kind === options.kind) return outcome;
  for (const migration of pendingMigrations(
    previousVersion,
    currentVersion,
    migrations,
    done,
    existingProfile,
  ))
    try {
      await migration.run({ userData, previousVersion, currentVersion });
      done.push(migration.id);
      outcome.ran.push(migration.id);
    } catch (error) {
      outcome.failed.push({ id: migration.id, message: (error as Error).message });
    }
  // Keep the old version recorded while a migration still has to be retried.
  const lastVersion = outcome.failed.length ? (previousVersion ?? '0.0.0') : currentVersion;
  await mkdir(userData, { recursive: true });
  await atomicWrite(
    path.join(userData, INSTALL_STATE_FILE),
    json({
      version: 1,
      lastVersion,
      ...(outcome.changed && previousVersion
        ? { previousVersion }
        : state?.previousVersion
          ? { previousVersion: state.previousVersion }
          : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      updatedAt: (options.now?.() ?? new Date()).toISOString(),
      migrations: done,
    } satisfies InstallState),
  );
  return outcome;
}
