// Builds release/Vmotion-Setup-<version>-x64.exe (NSIS, per-user) from the staged portable
// package produced by scripts/package.ts. The portable package itself is left untouched:
// the installer gets a copy without portable.flag/profile, so installed builds keep their
// settings in the per-user profile (%APPDATA%\vmotion).
//
//   npm run package:installer            (build + portable package + installer)
//   npx tsx scripts/package-installer.ts (reuse an existing release/Vmotion)
//
// makensis: MAKENSIS env, PATH, or the default NSIS install folder on Windows
// (CI: `choco install nsis`).
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { acquirePackageLock } from './package-publish.js';
import path from 'node:path';
import {
  installManifest,
  installerExcludedEntries,
  installerFileName,
  removalMacro,
  viProductVersion,
} from './installer-plan.js';

const root = path.resolve('.'),
  source = path.resolve(process.env.VMOTION_PACKAGE_ROOT ?? path.join(root, 'release/Vmotion')),
  release = path.dirname(source);
if (path.basename(source) !== 'Vmotion')
  throw new Error('VMOTION_PACKAGE_ROOT must name a Vmotion directory');
for (const required of ['Vmotion.exe', 'portable-manifest.json', 'resources/app/package.json'])
  if (!existsSync(path.join(source, required)))
    throw new Error(`Build the portable package first (missing ${required} in ${source})`);

const portable = JSON.parse(await readFile(path.join(source, 'portable-manifest.json'), 'utf8'));
const version = JSON.parse(await readFile(path.join(source, 'resources/app/package.json'), 'utf8'))
  .version as string;
if (typeof version !== 'string') throw new Error('Packaged app has no version');
const outputName = installerFileName(version),
  output = path.join(release, outputName),
  work = path.join(release, `.installer-${randomUUID()}`),
  stage = path.join(work, 'Vmotion');

function findMakensis() {
  const candidates = [
    process.env.MAKENSIS,
    process.platform === 'win32' ? 'makensis.exe' : 'makensis',
    ...(process.platform === 'win32'
      ? [
          path.join(
            process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
            'NSIS/makensis.exe',
          ),
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NSIS/makensis.exe'),
        ]
      : []),
  ].filter((value): value is string => !!value);
  for (const candidate of candidates)
    if (spawnSync(candidate, ['-VERSION'], { windowsHide: true }).status === 0) return candidate;
  throw new Error(
    'makensis not found: install NSIS 3 (Windows: `choco install nsis -y`; Debian: `apt-get install nsis`) or set MAKENSIS',
  );
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
  }
  return total;
}

const sha256 = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

const makensis = findMakensis();
const releaseLock = await acquirePackageLock(release);
await mkdir(work, { recursive: true });
try {
  await cp(source, stage, {
    recursive: true,
    filter: (file) =>
      path.dirname(file) !== source || !installerExcludedEntries.includes(path.basename(file)),
  });
  // CLI launcher directory the installer can add to the user PATH (`vmotion --version`).
  await mkdir(path.join(stage, 'bin'), { recursive: true });
  await writeFile(
    path.join(stage, 'bin', 'vmotion.cmd'),
    '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "ESBUILD_BINARY_PATH=%~dp0..\\resources\\compiler\\esbuild.exe"\r\n"%~dp0..\\Vmotion.exe" "%~dp0..\\resources\\app\\dist\\cli\\index.mjs" %*\r\nexit /b %errorlevel%\r\n',
  );
  await writeFile(
    path.join(stage, 'READ-ME.txt'),
    `Vmotion ${version} · Windows 10/11 x64（安装版）\r\n从开始菜单或桌面快捷方式启动 Vmotion。设置、最近项目与界面缓存保存在 %APPDATA%\\vmotion；工程和素材保存在你选择的位置。\r\n覆盖安装新版本会保留设置与最近项目；卸载默认也保留它们，可在卸载器中勾选一并删除。\r\nCLI/MCP：bin\\vmotion.cmd（安装时可加入用户 PATH，之后在新终端直接运行 vmotion）。Agent 指南在 Agent 文件夹。\r\n第三方许可、媒体来源与对应源码见 resources\\runtime\\licenses 和 sources；内容清单见 install-manifest.json。\r\n`,
  );
  await writeFile(
    path.join(stage, 'install-manifest.json'),
    JSON.stringify(installManifest(portable, outputName), null, 2) + '\n',
  );
  for (const excluded of installerExcludedEntries)
    if (existsSync(path.join(stage, excluded)))
      throw new Error(`${excluded} must not be shipped in the installer`);
  const entries = (await readdir(stage, { withFileTypes: true })).map((entry) => ({
    name: entry.name,
    directory: entry.isDirectory(),
  }));
  const filesNsh = path.join(work, 'files.nsh');
  await writeFile(filesNsh, '\ufeff' + removalMacro(entries));
  const estimatedKb = Math.ceil((await directorySize(stage)) / 1024);
  const partial = path.join(work, outputName);
  const define = (name: string, value: string | number) => `-D${name}=${value}`;
  execFileSync(
    makensis,
    [
      process.env.VMOTION_NSIS_VERBOSE ? '-V4' : '-V2',
      '-INPUTCHARSET',
      'UTF8',
      define('VERSION', version),
      define('VIVERSION', viProductVersion(version)),
      define('SOURCE_DIR', stage),
      define('FILES_NSH', filesNsh),
      define('OUTFILE', partial),
      define('ESTIMATED_KB', estimatedKb),
      path.join(root, 'scripts/installer/vmotion.nsi'),
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  await rename(partial, output);
  const digest = await sha256(output);
  await writeFile(output + '.sha256', `${digest}  ${outputName}\r\n`);
  process.stdout.write(
    JSON.stringify(
      {
        output,
        version,
        bytes: (await stat(output)).size,
        sha256: digest,
        installedKb: estimatedKb,
        portable: false,
        gitCommit: portable.gitCommit,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await rm(work, { recursive: true, force: true });
  await releaseLock();
}
