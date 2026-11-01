import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Application version for `vmotion --version`, read from the nearest `vmotion` package.json:
 * `<repo>/package.json` from src/cli (tsx) or dist/cli, and `resources/app/package.json`
 * in the portable and installed Windows builds.
 */
export function packageVersion(
  from: string,
  read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
) {
  let directory = path.dirname(from.startsWith('file:') ? fileURLToPath(from) : from);
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(read(path.join(directory, 'package.json')));
      if (manifest?.name === 'vmotion' && typeof manifest.version === 'string')
        return manifest.version as string;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return '0.0.0-unknown';
}
