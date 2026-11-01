import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchProjectArgument, selectProfile } from '../src/desktop/profile.js';
import {
  INSTALL_STATE_FILE,
  pendingMigrations,
  runVersionMigration,
  type ProfileMigration,
} from '../src/desktop/version-migration.js';
import { projectRoot } from '../src/desktop/projects.js';
import { packageVersion } from '../src/cli/version.js';
import {
  installManifest,
  installerExcludedEntries,
  installerFileName,
  nsisString,
  removalMacro,
  viProductVersion,
} from '../scripts/installer-plan.js';

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'vmotion-installer-'));
const migration = (id: string, introducedIn: string, log: string[] = []): ProfileMigration => ({
  id,
  introducedIn,
  run: () => {
    log.push(id);
  },
});

describe('desktop profile selection (installer vs portable)', () => {
  const exe = path.join('C:', 'Apps', 'Vmotion', 'Vmotion.exe');
  it('keeps the portable profile beside Vmotion.exe only when portable.flag exists', () => {
    expect(
      selectProfile({
        isPackaged: true,
        execPath: exe,
        exists: (f) => f.endsWith('portable.flag'),
      }),
    ).toEqual({ kind: 'portable', userData: path.join(path.dirname(exe), 'profile') });
    expect(selectProfile({ isPackaged: true, execPath: exe, exists: () => false })).toEqual({
      kind: 'installed',
    });
    expect(selectProfile({ isPackaged: false, execPath: exe, exists: () => true })).toEqual({
      kind: 'development',
    });
    expect(
      selectProfile({ testUserData: 'x', isPackaged: true, execPath: exe, exists: () => true }),
    ).toEqual({ kind: 'test', userData: path.resolve('x') });
  });
  it('reads --project from launch arguments (file association, folder verb)', () => {
    expect(launchProjectArgument(['Vmotion.exe'])).toBeUndefined();
    expect(launchProjectArgument(['Vmotion.exe', '--project', 'D:\\工程\\a.vmotion'])).toBe(
      'D:\\工程\\a.vmotion',
    );
    expect(() => launchProjectArgument(['Vmotion.exe', '--project'])).toThrow('--project');
    expect(() => launchProjectArgument(['Vmotion.exe', '--project', '--x'])).toThrow();
  });
  it('maps a .vmotion file to its project folder but leaves folders alone', () => {
    const dir = path.resolve('proj');
    expect(projectRoot(path.join(dir, 'Open.vmotion'), () => true)).toBe(dir);
    expect(projectRoot(path.join(dir, 'named.vmotion'), () => false)).toBe(
      path.join(dir, 'named.vmotion'),
    );
    expect(projectRoot(path.join(dir, 'project.vmotion.json'))).toBe(dir);
    expect(projectRoot(path.join(dir, '.vmotion'), () => true)).toBe(path.join(dir, '.vmotion'));
  });
});

describe('one-time profile migration on version change', () => {
  const all = [migration('a', '0.1.6'), migration('b', '0.2.0'), migration('c', '0.3.0')];
  it('selects migrations newer than the last version up to the current one', () => {
    expect(pendingMigrations('0.1.5', '0.2.0', all, [], true).map((m) => m.id)).toEqual(['a', 'b']);
    expect(pendingMigrations('0.2.0', '0.2.0', all, [], true)).toEqual([]);
    expect(pendingMigrations('0.3.0', '0.2.0', all, [], true)).toEqual([]);
    expect(pendingMigrations('0.1.5', '0.3.0', all, ['b'], true).map((m) => m.id)).toEqual([
      'a',
      'c',
    ]);
    // Profile written before the hook existed counts as 0.0.0; a fresh profile has nothing.
    expect(pendingMigrations(undefined, '0.2.0', all, [], true).map((m) => m.id)).toEqual([
      'a',
      'b',
    ]);
    expect(pendingMigrations(undefined, '0.2.0', all, [], false)).toEqual([]);
    expect(pendingMigrations('garbage', '0.2.0', all, [], true)).toEqual([]);
  });
  it('records the version, runs each migration once and retries failures', async () => {
    const dir = temp();
    try {
      writeFileSync(path.join(dir, 'settings.json'), '{"theme":"dark"}');
      const log: string[] = [];
      const first = await runVersionMigration(dir, '0.2.0', {
        kind: 'installed',
        migrations: [migration('a', '0.1.6', log)],
      });
      expect(first).toMatchObject({ previousVersion: undefined, changed: true, ran: ['a'] });
      const state = JSON.parse(readFileSync(path.join(dir, INSTALL_STATE_FILE), 'utf8'));
      expect(state).toMatchObject({ lastVersion: '0.2.0', kind: 'installed', migrations: ['a'] });
      const again = await runVersionMigration(dir, '0.2.0', {
        kind: 'installed',
        migrations: [migration('a', '0.1.6', log)],
      });
      expect(again).toMatchObject({ changed: false, ran: [] });
      expect(log).toEqual(['a']);
      let attempts = 0;
      const flaky: ProfileMigration = {
        id: 'flaky',
        introducedIn: '0.3.0',
        run: () => {
          if (attempts++ === 0) throw new Error('disk busy');
        },
      };
      const failed = await runVersionMigration(dir, '0.3.0', {
        kind: 'installed',
        migrations: [flaky],
      });
      expect(failed.failed).toEqual([{ id: 'flaky', message: 'disk busy' }]);
      expect(JSON.parse(readFileSync(path.join(dir, INSTALL_STATE_FILE), 'utf8')).lastVersion).toBe(
        '0.2.0',
      );
      const retried = await runVersionMigration(dir, '0.3.0', {
        kind: 'installed',
        migrations: [flaky],
      });
      expect(retried).toMatchObject({ previousVersion: '0.2.0', ran: ['flaky'], failed: [] });
      expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual({
        theme: 'dark',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('creates a missing profile directory and runs nothing on a fresh profile', async () => {
    const dir = path.join(temp(), 'new profile');
    try {
      const log: string[] = [];
      const outcome = await runVersionMigration(dir, '0.1.5', {
        migrations: [migration('a', '0.1.0', log)],
      });
      expect(outcome.ran).toEqual([]);
      expect(existsSync(path.join(dir, INSTALL_STATE_FILE))).toBe(true);
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});

describe('CLI version', () => {
  it('reads the vmotion package.json version from the CLI location', () => {
    const files: Record<string, string> = {
      [path.join('/app', 'package.json')]: '{"name":"vmotion","version":"9.8.7"}',
      [path.join('/app/dist', 'package.json')]: '{"name":"other","version":"1.0.0"}',
    };
    const read = (file: string) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    };
    expect(packageVersion(path.join('/app/dist/cli/index.mjs'), read)).toBe('9.8.7');
    expect(packageVersion(path.join('/nowhere/cli/index.mjs'), read)).toBe('0.0.0-unknown');
    const repo = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version;
    expect(packageVersion(path.resolve('src/cli/index.ts'))).toBe(repo);
  });
});

describe('installer plan', () => {
  it('names the installer and Windows version', () => {
    expect(installerFileName('0.1.5')).toBe('Vmotion-Setup-0.1.5-x64.exe');
    expect(viProductVersion('0.1.5')).toBe('0.1.5.0');
    expect(viProductVersion('1.2.3-beta.4')).toBe('1.2.3.0');
    expect(() => viProductVersion('dev')).toThrow();
  });
  it('never ships the portable marker or a profile', () => {
    expect(installerExcludedEntries).toEqual(
      expect.arrayContaining(['portable.flag', 'profile', 'portable-manifest.json']),
    );
    expect(installManifest({ settings: 'profile', entry: 'Vmotion.exe' }, 'x.exe')).toMatchObject({
      kind: 'installer',
      settings: 'user-profile',
      entry: 'Vmotion.exe',
      cli: 'bin/vmotion.cmd',
    });
  });
  it('removes only the top-level entries the installer owns', () => {
    const macro = removalMacro([
      { name: 'resources', directory: true },
      { name: 'Vmotion.exe', directory: false },
      { name: '启动 Agent 工作台.cmd', directory: false },
      { name: 'a$b', directory: false },
    ]);
    expect(macro).toContain('RMDir /r "$INSTDIR\\resources"');
    expect(macro).toContain('Delete "$INSTDIR\\Vmotion.exe"');
    expect(macro).toContain('Delete "$INSTDIR\\启动 Agent 工作台.cmd"');
    expect(macro).toContain('Delete "$INSTDIR\\a$$b"');
    expect(macro).not.toMatch(/RMDir \/r "\$INSTDIR"/);
    expect(() => removalMacro([{ name: '..', directory: true }])).toThrow();
    expect(() => removalMacro([{ name: 'a\\b', directory: false }])).toThrow();
    expect(nsisString('say "hi" $x')).toBe('"say $\\"hi$\\" $$x"');
  });
});
