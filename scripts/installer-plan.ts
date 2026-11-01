// Pure helpers for scripts/package-installer.ts (unit-tested in tests/installer.test.ts).

/** `Vmotion-Setup-<version>-x64.exe` */
export const installerFileName = (version: string) => `Vmotion-Setup-${version}-x64.exe`;

/** NSIS VIProductVersion needs four numeric parts: 0.1.5 → 0.1.5.0, 1.2.3-beta.4 → 1.2.3.0. */
export function viProductVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Cannot derive a Windows file version from ${version}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}.0`;
}

/** Escape literal text inside an NSIS "..." string: $ → $$, " → $\", newlines rejected. */
export function nsisEscape(value: string) {
  if (/[\r\n]/.test(value)) throw new Error('NSIS strings cannot contain newlines');
  return value.replace(/\$/g, '$$$$').replace(/"/g, '$\\"');
}
export const nsisString = (value: string) => `"${nsisEscape(value)}"`;

/**
 * Entries of the portable package that must NOT go into the installer: the portable
 * marker (installed builds use the per-user profile), any developer profile, and the
 * portable manifest (replaced by install-manifest.json).
 */
export const installerExcludedEntries = ['portable.flag', 'profile', 'portable-manifest.json'];

export interface StagedEntry {
  name: string;
  directory: boolean;
}

/**
 * The VM_REMOVE_PROGRAM macro: removes exactly the top-level entries this installer
 * writes into $INSTDIR, never the directory recursively, so projects or other files a
 * user keeps in the install folder survive both upgrade cleanup and uninstall.
 */
export function removalMacro(entries: readonly StagedEntry[]) {
  const lines = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      if (!entry.name || /[\\/]/.test(entry.name) || entry.name === '.' || entry.name === '..')
        throw new Error(`Invalid top-level package entry: ${entry.name}`);
      const target = `"$INSTDIR\\${nsisEscape(entry.name)}"`;
      return entry.directory ? `  RMDir /r ${target}` : `  Delete ${target}`;
    });
  return ['!macro VM_REMOVE_PROGRAM', ...lines, '!macroend', ''].join('\r\n');
}

/** Installed-build manifest derived from the portable manifest. */
export function installManifest(portable: Record<string, unknown>, installerName: string) {
  return {
    ...portable,
    kind: 'installer',
    installer: installerName,
    settings: 'user-profile',
    userProfile: '%APPDATA%\\vmotion',
    cli: 'bin/vmotion.cmd',
  };
}
