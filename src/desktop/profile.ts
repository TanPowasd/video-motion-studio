import path from 'node:path';

/**
 * Where the desktop app keeps settings, recent projects and its Chromium profile.
 *
 * - `test`: VMOTION_TEST_USER_DATA (isolated acceptance runs).
 * - `portable`: packaged build with `portable.flag` beside Vmotion.exe → `<exe dir>/profile`.
 * - `installed`: packaged build without the flag (the NSIS installer never ships it) →
 *   Electron's per-user default `%APPDATA%\vmotion`, which survives upgrades and uninstall.
 * - `development`: `electron .` from the source tree, same per-user default.
 *
 * `userData` is undefined when Electron's default should be kept.
 */
export type ProfileKind = 'test' | 'portable' | 'installed' | 'development';
export interface ProfileSelection {
  kind: ProfileKind;
  userData?: string;
}
export function selectProfile(options: {
  testUserData?: string;
  isPackaged: boolean;
  execPath: string;
  exists: (file: string) => boolean;
}): ProfileSelection {
  if (options.testUserData) return { kind: 'test', userData: path.resolve(options.testUserData) };
  if (!options.isPackaged) return { kind: 'development' };
  const directory = path.dirname(options.execPath);
  if (options.exists(path.join(directory, 'portable.flag')))
    return { kind: 'portable', userData: path.join(directory, 'profile') };
  return { kind: 'installed' };
}

/**
 * Project path from desktop launch arguments: `--project <path>`, used by the CLI, the
 * `.vmotion` file association and the folder context menu the installer registers.
 */
export function launchProjectArgument(argv: readonly string[]) {
  const flag = argv.indexOf('--project');
  if (flag < 0) return undefined;
  const value = argv[flag + 1];
  if (!value || value.startsWith('--')) throw new Error('--project 后需要提供项目路径');
  return value;
}
