import { cp, mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquirePackageLock, publishPackage } from './package-publish.js';
const root = path.resolve('.'),
  release = path.join(root, 'release'),
  stage = path.join(release, `.staging-${randomUUID()}`),
  target = path.join(release, 'Vmotion');
if (process.platform !== 'win32')
  throw new Error('The current portable package target is Windows x64');
await stat(path.join(root, 'dist/native/manifest.json'));
await stat(path.join(root, 'dist/desktop/main.cjs'));
const releaseLock = await acquirePackageLock(release);
try {
  await mkdir(stage, { recursive: true });
  await cp(path.join(root, 'node_modules/electron/dist'), stage, { recursive: true });
  await rename(path.join(stage, 'electron.exe'), path.join(stage, 'Vmotion.exe'));
  const app = path.join(stage, 'resources/app');
  await mkdir(app, { recursive: true });
  for (const entry of ['dist', 'schemas', 'docs', 'LICENSE', 'README.md'])
    await cp(path.join(root, entry), path.join(app, entry), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  delete manifest.devDependencies;
  delete manifest.scripts;
  await writeFile(path.join(app, 'package.json'), JSON.stringify(manifest, null, 2));
  await cp(path.join(root, 'examples/science'), path.join(app, 'examples/science'), {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
  });
  if (existsSync(path.join(root, 'examples/animation-lab')))
    await cp(path.join(root, 'examples/animation-lab'), path.join(app, 'examples/animation-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  if (existsSync(path.join(root, 'examples/parameter-lab')))
    await cp(path.join(root, 'examples/parameter-lab'), path.join(app, 'examples/parameter-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  if (existsSync(path.join(root, 'examples/audio-lab')))
    await cp(path.join(root, 'examples/audio-lab'), path.join(app, 'examples/audio-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  if (existsSync(path.join(root, 'examples/visual-audit-lab')))
    await cp(
      path.join(root, 'examples/visual-audit-lab'),
      path.join(app, 'examples/visual-audit-lab'),
      {
        recursive: true,
        filter: (file) =>
          !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
      },
    );
  const npmCli =
    process.env.npm_execpath ??
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (existsSync(path.join(root, 'examples/vector-lab')))
    await cp(path.join(root, 'examples/vector-lab'), path.join(app, 'examples/vector-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  const dependencies = execFileSync(
    process.execPath,
    [npmCli, 'ls', '--omit=dev', '--all', '--parseable'],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
    .trim()
    .split(/\r?\n/)
    .filter((p) => path.resolve(p) !== root);
  if (existsSync(path.join(root, 'examples/repeater-lab')))
    await cp(path.join(root, 'examples/repeater-lab'), path.join(app, 'examples/repeater-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  if (existsSync(path.join(root, 'examples/shared-scene-lab')))
    await cp(
      path.join(root, 'examples/shared-scene-lab'),
      path.join(app, 'examples/shared-scene-lab'),
      {
        recursive: true,
        filter: (file) =>
          !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
      },
    );
  for (const name of [
    'time-lab',
    'editing-lab',
    'linear-algebra-lab',
    'matrix3d-lab',
    'depth3d-lab',
    'mesh-gallery',
    'material-gallery',
    'effects2d-lab',
    'temporal-lab',
    'effect-graph-lab',
    'drivers-lab',
    'sound-lab',
    'workstation-lab',
    'storyboard-lab',
    'visual-fields-lab',
    'typography-lab',
    'tracking-lab',
    'design-lab',
    'plugin-lab',
    'graph-outputs-lab',
    'keying-lab',
    'animation-layers-lab',
  ])
    if (existsSync(path.join(root, `examples/${name}`)))
      await cp(path.join(root, `examples/${name}`), path.join(app, `examples/${name}`), {
        recursive: true,
        filter: (file) =>
          !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
      });
  for (const dependency of dependencies) {
    const relative = path.relative(root, dependency);
    if (relative.startsWith('..') || !relative.startsWith('node_modules' + path.sep))
      throw new Error(`Dependency outside package root: ${dependency}`);
    await cp(dependency, path.join(app, relative), { recursive: true });
  }
  await cp(path.join(root, 'dist/native'), path.join(stage, 'resources/native'), {
    recursive: true,
  });
  await mkdir(path.join(stage, 'resources/compiler'), { recursive: true });
  await cp(
    path.join(root, 'node_modules/@esbuild/win32-x64/esbuild.exe'),
    path.join(stage, 'resources/compiler/esbuild.exe'),
  );
  await writeFile(
    path.join(stage, 'READ-ME.txt'),
    'Vmotion Windows x64 便携预览版\r\n运行 Vmotion.exe 进入项目首页。选择“新建项目”创建空白工程，或“打开项目”选择工程文件夹。\r\n编辑器顶部也提供新建/打开入口（Ctrl+N / Ctrl+O）。工程保存在你选择的位置，最近项目列表保存在用户数据中。\r\nNode 和原生核心已包含；音视频导出仍需要 PATH 上的 ffmpeg 和 ffprobe。\r\n当前预览版尚未内置媒体运行时与 GPU 后端。\r\n',
  );
  await publishPackage(stage, target);
  await writeFile(
    path.join(release, '启动 Vmotion.cmd'),
    '@echo off\r\nstart "" "%~dp0Vmotion\\Vmotion.exe"\r\n',
  );
  await writeFile(
    path.join(release, '使用说明.txt'),
    '当前版本：Vmotion\\Vmotion.exe，或双击“启动 Vmotion.cmd”。\r\nVmotion-previous-* 是历史封装备份；更新不会修改这些旧版本。\r\n当前版本启动后显示项目首页，支持空白工程与科普模板，新建/打开入口在首页和编辑器顶部。\r\n',
  );
  process.stdout.write(
    JSON.stringify(
      {
        output: path.join(target, 'Vmotion.exe'),
        dependencies: dependencies.length,
        ffmpegBundled: false,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await releaseLock();
}
