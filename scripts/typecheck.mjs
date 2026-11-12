import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const normalizedRoot = root.replaceAll('\\', '/');
const diagnostics = process.argv.includes('--diagnostics');
const keepCache = process.argv.includes('--keep-cache');
const onlyLayer = process.argv.find((arg) => arg.startsWith('--layer='))?.slice('--layer='.length);
const fromLayer = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length);
const workerLayer = process.argv
  .find((arg) => arg.startsWith('--worker='))
  ?.slice('--worker='.length);
const tmpDir = path.resolve(root, '.vmotion/typecheck');
const dtsDir = path.join(tmpDir, 'dts');

const hostServiceFiles = new Set([
  'src/service/application.ts',
  'src/service/rpc-contract.ts',
  'src/service/http.ts',
  'src/service/ipc.ts',
  'src/service/remote-host.ts',
]);

function collectTsFiles(relDir) {
  const absDir = path.resolve(root, relDir);
  const out = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const nextRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(nextRel));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(nextRel);
    }
  }
  return out.sort();
}

const serviceBaseFiles = collectTsFiles('src/service').filter(
  (relPath) => !hostServiceFiles.has(relPath),
);
const serviceSlice = Math.ceil(serviceBaseFiles.length / 8);

const pluginBarrelFiles = new Set(['src/plugins/index.ts', 'src/plugins/rpc-handlers.ts']);
const pluginInfraFiles = [
  'src/plugins/candidate.ts',
  'src/plugins/registry.ts',
  'src/plugins/rpc-handler.ts',
  'src/plugins/types.ts',
];
const pluginInfraSet = new Set(pluginInfraFiles);
const pluginLeafFiles = collectTsFiles('src/plugins').filter(
  (relPath) => !pluginBarrelFiles.has(relPath) && !pluginInfraSet.has(relPath),
);
const pluginSliceSize = Math.ceil(pluginLeafFiles.length / 4);

const coreSourceFiles = [
  ...collectTsFiles('src/platform'),
  ...collectTsFiles('src/core'),
  ...collectTsFiles('src/sdk'),
  ...collectTsFiles('src/media'),
];
const mcpCoreFiles = collectTsFiles('src/mcp').filter((rel) => rel !== 'src/mcp/server.ts');
const editorTopSet = new Set(['src/editor/Workbench.tsx', 'src/editor/main.tsx']);
const editorAll = collectTsFiles('src/editor');
const editorLeafFiles = editorAll.filter(
  (rel) =>
    !editorTopSet.has(rel) &&
    !rel.startsWith('src/editor/studio/') &&
    !rel.startsWith('src/editor/panels/'),
);
const editorStudioFiles = editorAll.filter((rel) => rel.startsWith('src/editor/studio/'));
const editorStudioHalf = Math.ceil(editorStudioFiles.length / 2);
const editorTopFiles = [
  ...editorAll.filter((rel) => rel.startsWith('src/editor/panels/') || editorTopSet.has(rel)),
  ...collectTsFiles('src/agent-editor'),
];

const allTestFiles = collectTsFiles('tests');
const testSliceSize = Math.ceil(allTestFiles.length / 10);

/**
 * Layered TypeScript compilation units.
 * - `compiler-ast` checks the 7 files that use `typescript` / `mathjax-full` directly against
 *   their full upstream `.d.ts` definitions.
 * - `plugins-1` and `plugins-2` check all 19 builtin plugins in full and emit exact `.d.ts`
 *   boundaries so `host-mcp`, `cli`, `desktop`, `editor` and `tests-*` verify full RPC/MCP
 *   contracts without re-instantiating all 19 plugin implementation graphs in one V8 heap.
 */
const layers = [
  {
    name: 'compiler-ast',
    lib: ['ES2022'],
    types: ['node'],
    useRealTypescript: true,
    useRealMathjax: true,
    include: [
      'src/core/components.ts',
      'src/core/jsx-lint.ts',
      'src/core/jsx-writeback.ts',
      'src/core/project-references.ts',
      'src/core/rendering/node-formula.ts',
      'src/service/templates.ts',
      'scripts/build.ts',
    ],
  },
  {
    name: 'core',
    lib: ['ES2022'],
    types: ['node'],
    include: ['src/platform', 'src/core', 'src/sdk', 'src/media'],
    emitDtsFor: coreSourceFiles,
  },
  ...Array.from({ length: 8 }, (_, idx) => {
    const slice = serviceBaseFiles.slice(idx * serviceSlice, (idx + 1) * serviceSlice);
    return {
      name: `service-${idx + 1}`,
      lib: ['ES2022'],
      types: ['node'],
      useCachedDts: true,
      include: slice,
      emitDtsFor: slice,
    };
  }),
  ...Array.from({ length: 4 }, (_, idx) => {
    const slice = pluginLeafFiles.slice(idx * pluginSliceSize, (idx + 1) * pluginSliceSize);
    return {
      name: `plugins-${idx + 1}`,
      lib: ['ES2022'],
      types: ['node'],
      useCachedDts: true,
      include: idx === 0 ? [...pluginInfraFiles, ...slice] : slice,
      emitDtsFor: idx === 0 ? [...pluginInfraFiles, ...slice] : slice,
    };
  }),
  {
    name: 'plugins-barrels',
    lib: ['ES2022'],
    types: ['node'],
    useCachedDts: true,
    include: ['src/plugins/index.ts', 'src/plugins/rpc-handlers.ts'],
    emitDtsFor: ['src/plugins/index.ts', 'src/plugins/rpc-handlers.ts'],
  },
  {
    name: 'host-service-1',
    lib: ['ES2022'],
    types: ['node'],
    useCachedDts: true,
    include: [...mcpCoreFiles, 'src/service/rpc-contract.ts'],
    emitDtsFor: [...mcpCoreFiles, 'src/service/rpc-contract.ts'],
  },
  {
    name: 'host-service-2',
    lib: ['ES2022'],
    types: ['node'],
    useCachedDts: true,
    include: [
      'src/service/application.ts',
      'src/service/http.ts',
      'src/service/ipc.ts',
      'src/service/remote-host.ts',
    ],
    emitDtsFor: [
      'src/service/application.ts',
      'src/service/http.ts',
      'src/service/ipc.ts',
      'src/service/remote-host.ts',
    ],
  },
  {
    name: 'mcp-server',
    lib: ['ES2022'],
    types: ['node'],
    useCachedDts: true,
    include: ['src/mcp/server.ts'],
  },
  {
    name: 'cli',
    lib: ['ES2022'],
    types: ['node'],
    useCachedDts: true,
    include: ['src/cli'],
  },
  {
    name: 'desktop',
    lib: ['ES2022'],
    types: ['node'],
    useCachedDts: true,
    include: ['src/desktop'],
  },
  {
    name: 'editor-leaf',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: ['node', 'vite/client'],
    jsx: 'react-jsx',
    useCachedDts: true,
    include: editorLeafFiles,
    emitDtsFor: editorLeafFiles,
  },
  {
    name: 'editor-studio-1',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: ['node', 'vite/client'],
    jsx: 'react-jsx',
    useCachedDts: true,
    include: editorStudioFiles.slice(0, editorStudioHalf),
    emitDtsFor: editorStudioFiles.slice(0, editorStudioHalf),
  },
  {
    name: 'editor-studio-2',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: ['node', 'vite/client'],
    jsx: 'react-jsx',
    useCachedDts: true,
    include: editorStudioFiles.slice(editorStudioHalf),
    emitDtsFor: editorStudioFiles.slice(editorStudioHalf),
  },
  {
    name: 'editor-top',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: ['node', 'vite/client'],
    jsx: 'react-jsx',
    useCachedDts: true,
    include: [...editorTopFiles, 'vite.config.ts', 'vite.agent.config.ts'],
    emitDtsFor: editorTopFiles,
  },
  {
    name: 'scripts-examples',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: ['node'],
    jsx: 'react-jsx',
    useCachedDts: true,
    include: [
      'scripts',
      'examples/**/*.ts',
      'examples/**/*.tsx',
      'skills/**/*.ts',
      'skills/**/*.tsx',
      'vitest.config.ts',
    ],
  },
  ...Array.from({ length: 10 }, (_, idx) => ({
    name: `tests-${idx + 1}`,
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: ['node'],
    jsx: 'react-jsx',
    useCachedDts: true,
    include: allTestFiles.slice(idx * testSliceSize, (idx + 1) * testSliceSize),
  })),
];

const tsShimSource = `declare namespace ts {
  type Node = any;
  type SourceFile = any;
  type CompilerOptions = any;
  type JsxOpeningElement = any;
  type JsxSelfClosingElement = any;
  type JsxAttributeValue = any;
  type JsxAttribute = any;
  type Expression = any;
  type Identifier = any;
  type StringLiteralLike = any;
  type ModifierLike = any;
  type ObjectLiteralElementLike = any;
  type Diagnostic = any;
  type Program = any;
  type CompilerHost = any;
}
declare const ts: {
  createCompilerHost(options: any): {
    fileExists(file: string): boolean;
    directoryExists?(directory: string): boolean;
    readFile(file: string): string | undefined;
    getSourceFile(
      file: string,
      languageVersion: number,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): any;
    [key: string]: any;
  };
  getPreEmitDiagnostics(program: any): any[];
  formatDiagnosticsWithColorAndContext(
    diagnostics: any,
    host: {
      getCanonicalFileName(file: string): string;
      getCurrentDirectory(): string;
      getNewLine(): string;
    },
  ): string;
  [key: string]: any;
};
export = ts;
`;

const z2jShimSource = `import type { ZodTypeAny } from 'zod';
export interface ZodToJsonSchemaOptions {
  name?: string;
  $refStrategy?: 'root' | 'relative' | 'none' | 'seen';
  target?: 'jsonSchema7' | 'jsonSchema2019-09' | 'openApi3';
  errorMessages?: boolean;
  markdownDescription?: boolean;
  [key: string]: unknown;
}
export function zodToJsonSchema(
  schema: ZodTypeAny,
  options?: string | ZodToJsonSchemaOptions,
): Record<string, unknown>;
export default zodToJsonSchema;
`;

const mathjaxShimSource = `export function liteAdaptor(): any;
export function RegisterHTMLHandler(adaptor: any): any;
export class TeX {
  constructor(options?: any);
}
export const AllPackages: string[];
export const mathjax: {
  document(html: string, options?: any): { convert(tex: string, options?: any): any };
};
export class SVG {
  constructor(options?: any);
}
`;

function writeLayerConfig(layer) {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'ts-shim.d.ts'), tsShimSource);
  writeFileSync(path.join(tmpDir, 'z2j-shim.d.ts'), z2jShimSource);
  writeFileSync(path.join(tmpDir, 'mathjax-shim.d.ts'), mathjaxShimSource);
  const cfgPath = path.join(tmpDir, `tsconfig.${layer.name}.json`);
  const paths = {
    '@vmotion/sdk': ['src/sdk/index.ts'],
    '@vmotion/sdk/jsx-runtime': ['src/sdk/index.ts'],
    '@vmotion/sdk/jsx-dev-runtime': ['src/sdk/index.ts'],
    'zod-to-json-schema': ['.vmotion/typecheck/z2j-shim.d.ts'],
    ...(layer.useRealTypescript ? {} : { typescript: ['.vmotion/typecheck/ts-shim.d.ts'] }),
    ...(layer.useRealMathjax ? {} : { 'mathjax-full/*': ['.vmotion/typecheck/mathjax-shim.d.ts'] }),
  };
  const emitDts = Boolean(layer.emitDtsFor?.length);
  const config = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      baseUrl: '../..',
      ...(emitDts
        ? { declaration: true, emitDeclarationOnly: true }
        : { allowImportingTsExtensions: true, noEmit: true }),
      paths,
      lib: layer.lib,
      types: layer.types,
      ...(layer.jsx ? { jsx: layer.jsx } : {}),
      ...(layer.jsxImportSource ? { jsxImportSource: layer.jsxImportSource } : {}),
    },
    include: layer.include.map((entry) => `../../${entry}`),
  };
  writeFileSync(cfgPath, `${JSON.stringify(config, null, 2)}\n`);
  return cfgPath;
}

async function executeWorkerLayer(layerName) {
  const { default: ts } = await import('typescript');
  const layer = layers.find((item) => item.name === layerName);
  if (!layer) {
    process.stderr.write(`Unknown typecheck layer: ${layerName}\n`);
    process.exit(1);
  }
  const cfgPath = writeLayerConfig(layer);
  const formatHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  };
  const rawCfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  if (rawCfg.error) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext([rawCfg.error], formatHost));
    process.exit(1);
  }
  const parsed = ts.parseJsonConfigFileContent(rawCfg.config, ts.sys, path.dirname(cfgPath));
  if (parsed.errors.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost));
    process.exit(1);
  }

  const host = ts.createCompilerHost(parsed.options);
  if (layer.useCachedDts) {
    const ownSourceSet = new Set(
      parsed.fileNames.map((file) => path.resolve(file).replaceAll('\\', '/')),
    );
    const origFileExists = host.fileExists.bind(host);
    const origReadFile = host.readFile.bind(host);
    const origGetSourceFile = host.getSourceFile.bind(host);
    const origRealpath = host.realpath?.bind(host);

    const resolveCachedDts = (fileName) => {
      const norm = path.resolve(fileName).replaceAll('\\', '/');
      if (!norm.startsWith(`${normalizedRoot}/src/`) || !norm.endsWith('.d.ts')) {
        return null;
      }
      const rel = norm.slice(normalizedRoot.length + 1);
      const cached = path.join(dtsDir, rel);
      return existsSync(cached) ? cached : null;
    };

    const isSubstitutedTs = (fileName) => {
      const norm = path.resolve(fileName).replaceAll('\\', '/');
      if (
        !norm.startsWith(`${normalizedRoot}/src/`) ||
        (!norm.endsWith('.ts') && !norm.endsWith('.tsx')) ||
        norm.endsWith('.d.ts') ||
        ownSourceSet.has(norm)
      ) {
        return false;
      }
      const relDts = norm.slice(normalizedRoot.length + 1).replace(/\.tsx?$/, '.d.ts');
      return existsSync(path.join(dtsDir, relDts));
    };

    host.fileExists = (fileName) => {
      if (isSubstitutedTs(fileName)) return false;
      if (resolveCachedDts(fileName)) return true;
      return origFileExists(fileName);
    };
    host.readFile = (fileName) => {
      const cached = resolveCachedDts(fileName);
      return cached ? origReadFile(cached) : origReadFile(fileName);
    };
    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
      const cached = resolveCachedDts(fileName);
      if (cached) {
        const text = origReadFile(cached);
        return text !== undefined
          ? ts.createSourceFile(fileName, text, languageVersionOrOptions)
          : undefined;
      }
      return origGetSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
    };
    if (origRealpath) {
      host.realpath = (fileName) =>
        resolveCachedDts(fileName) ? path.resolve(fileName) : origRealpath(fileName);
    }
  }

  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const allDiagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];

  if (allDiagnostics.length === 0 && layer.emitDtsFor?.length) {
    for (const relFile of layer.emitDtsFor) {
      const absFile = path.resolve(root, relFile);
      const sf =
        program.getSourceFile(absFile) ?? program.getSourceFile(absFile.replaceAll('\\', '/'));
      if (!sf) {
        process.stderr.write(`Missing source file for declaration emit: ${relFile}\n`);
        process.exit(1);
      }
      let emittedText = null;
      const emitRes = program.emit(
        sf,
        (fileName, text) => {
          if (fileName.endsWith('.d.ts')) emittedText = text;
        },
        undefined,
        true,
      );
      if (emitRes.diagnostics.length === 0 && emittedText !== null) {
        const outFile = path.join(dtsDir, relFile.replace(/\.tsx?$/, '.d.ts'));
        mkdirSync(path.dirname(outFile), { recursive: true });
        writeFileSync(outFile, emittedText);
      }
    }
  }

  if (allDiagnostics.length) {
    process.stdout.write(ts.formatDiagnosticsWithColorAndContext(allDiagnostics, formatHost));
    process.exit(1);
  }

  if (diagnostics) {
    const rssKb = Math.round(process.memoryUsage().rss / 1024);
    const heapKb = Math.round(process.memoryUsage().heapUsed / 1024);
    process.stdout.write(
      `__STATS__ files=${program.getSourceFiles().length} heap=${heapKb}K rss=${rssKb}K\n`,
    );
  }
}

if (workerLayer) {
  await executeWorkerLayer(workerLayer);
} else {
  function runLayerChild(layer) {
    return new Promise((resolve) => {
      const started = Date.now();
      const args = [
        '--max-old-space-size=500',
        '--max-semi-space-size=8',
        path.resolve(root, 'scripts/typecheck.mjs'),
        `--worker=${layer.name}`,
        ...(diagnostics ? ['--diagnostics'] : []),
      ];
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      child.on('exit', (code) => {
        const elapsed = ((Date.now() - started) / 1000).toFixed(2);
        const statsLine = stdout
          .split('\n')
          .find((line) => line.startsWith('__STATS__ '))
          ?.slice('__STATS__ '.length)
          .trim();
        const cleanStdout = stdout
          .split('\n')
          .filter((line) => !line.startsWith('__STATS__ '))
          .join('\n');
        if (cleanStdout.trim()) process.stdout.write(cleanStdout);
        if (diagnostics) {
          console.log(`[typecheck] ${layer.name} (${elapsed}s) ${statsLine ?? 'failed'}`);
        } else if (code === 0) {
          console.log(`[typecheck] ${layer.name} ok (${elapsed}s)`);
        }
        resolve(code ?? 1);
      });
    });
  }

  const fromIndex = fromLayer ? layers.findIndex((l) => l.name === fromLayer) : 0;
  const selectedLayers = onlyLayer
    ? layers.filter((l) => l.name === onlyLayer)
    : layers.slice(Math.max(0, fromIndex));
  if (!onlyLayer && !fromLayer && !keepCache) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  try {
    for (const layer of selectedLayers) {
      const code = await runLayerChild(layer);
      if (code !== 0) {
        process.exitCode = code;
        break;
      }
    }
  } finally {
    if (!onlyLayer && !fromLayer && !keepCache) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
