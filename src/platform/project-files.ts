import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { VmotionError } from '../core/model.js';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function safePath(root: string, relative: string) {
  const base = path.resolve(root);
  const file = path.resolve(root, relative);
  if (file !== base && !file.startsWith(base + path.sep))
    throw new VmotionError('PATH_OUTSIDE_PROJECT', `Path leaves the project: ${relative}`);
  return file;
}

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export function projectFolder(parent: string, name: string) {
  if (!path.isAbsolute(parent)) throw new Error('请选择绝对路径作为项目保存位置');
  if (
    !name ||
    name !== name.trim() ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    name === '.' ||
    name === '..'
  )
    throw new Error('项目名称不能包含 Windows 路径保留字符或保留名称');
  const root = path.resolve(parent, name);
  if (path.dirname(root) !== path.resolve(parent)) throw new Error('项目必须保存到所选文件夹中');
  return root;
}

export async function atomicWrite(
  file: string,
  content: string | Uint8Array,
  renameFile: typeof rename = rename,
) {
  return atomicSave(file, (temporary) => writeFile(temporary, content), renameFile);
}

/** Publish large media without allocating the entire file in JavaScript memory. */
export async function atomicCopy(source: string, file: string) {
  return atomicSave(file, (temporary) => copyFile(source, temporary), rename);
}

async function atomicSave(
  file: string,
  write: (temporary: string) => Promise<unknown>,
  renameFile: typeof rename,
) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let attempts = 0;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await write(temporary);
    const waits = [10, 25, 50, 100, 200];
    for (;;) {
      attempts++;
      try {
        await renameFile(temporary, file);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempts > waits.length || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw e;
        await delay(waits[attempts - 1]);
      }
    }
  } catch (e) {
    await unlink(temporary).catch(() => {});
    throw new VmotionError(
      'FILE_WRITE',
      `Atomic save failed for ${file}: ${(e as Error).message}`,
      { file, systemCode: (e as NodeJS.ErrnoException).code, attempts },
    );
  }
}
