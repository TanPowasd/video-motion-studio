import path from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { z } from 'zod';
import { atomicWrite, json } from '../service/project.js';
import { projectFolder } from '../platform/project-files.js';
import type { RecentProject } from '../core/project-creation.js';

export { projectFolder };

const recentSchema = z.array(
  z.object({ root: z.string(), name: z.string(), openedAt: z.string() }),
);
const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};
/**
 * Project folder for a path the user opened: the folder itself, its `project.vmotion.json`,
 * or any `*.vmotion` file inside it (the installer's optional file association).
 */
export function projectRoot(input: string, fileCheck: (file: string) => boolean = isFile) {
  const root = path.resolve(input),
    name = path.basename(root).toLowerCase();
  if (name === 'project.vmotion.json') return path.dirname(root);
  if (name.endsWith('.vmotion') && name !== '.vmotion' && fileCheck(root))
    return path.dirname(root);
  return root;
}
export async function readRecent(file: string): Promise<RecentProject[]> {
  try {
    return recentSchema.parse(JSON.parse(await readFile(file, 'utf8'))).slice(0, 12);
  } catch {
    return [];
  }
}
export async function availableRecent(file: string) {
  return Promise.all(
    (await readRecent(file)).map(async (entry) => ({
      ...entry,
      available: await access(path.join(entry.root, 'project.vmotion.json')).then(
        () => true,
        () => false,
      ),
    })),
  );
}
export async function rememberProject(file: string, root: string, name: string) {
  const key = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const recent = [
    { root: path.resolve(root), name, openedAt: new Date().toISOString() },
    ...(await readRecent(file)).filter((entry) => key(entry.root) !== key(root)),
  ].slice(0, 12);
  await atomicWrite(file, json(recent));
}
