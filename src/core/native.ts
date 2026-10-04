import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateNode } from './time.js';
import { VmotionError, type Node } from './model.js';
import { rasterize3D, type RasterRequest, type RasterResult } from './raster3d.js';
export class NativeEvaluator {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (e: Error) => void }
  >();
  private counter = 0;
  private buffer = '';
  readonly binary =
    process.env.VMOTION_NATIVE ??
    (() => {
      const dir = path.dirname(
        typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
          ? fileURLToPath(import.meta.url)
          : String(import.meta.url),
      );
      const bundled = resolveNativeBinary(path.resolve(dir, '../native'));
      return existsSync(bundled)
        ? bundled
        : resolveNativeBinary(path.resolve(dir, '../../dist/native'));
    })();
  get available() {
    return existsSync(this.binary);
  }
  async evaluate(nodes: Node[], frame: number): Promise<Node[]> {
    if (!this.available) return Promise.resolve(nodes.map((n) => evaluateNode(n, frame)));
    const animated = nodes.filter((n) => n.animations.length);
    if (!animated.length) return nodes.map((n) => evaluateNode(n, frame));
    // Mesh topology does not animate through numeric channels; do not resend it for keyframe evaluation.
    const compact = animated.map((n) =>
        n.scene3d
          ? {
              ...n,
              scene3d: {
                ...n.scene3d,
                instances: n.scene3d.instances.map(({ mesh, ...instance }) => instance),
              },
            }
          : n,
      ),
      evaluated = await this.request<Node[]>('evaluate', { nodes: compact, frame });
    evaluated.forEach((node, i) => {
      if (node.scene3d && animated[i].scene3d)
        node.scene3d.instances = node.scene3d.instances.map((instance, j) => ({
          ...instance,
          mesh: animated[i].scene3d!.instances[j].mesh,
        }));
    });
    let cursor = 0;
    return nodes.map((n) => (n.animations.length ? evaluated[cursor++] : evaluateNode(n, frame)));
  }
  async raster3D(request: RasterRequest): Promise<RasterResult> {
    if (!this.available) return rasterize3D(request);
    let result: {
      rgba: string;
      depth?: string;
      faceIds?: string;
      triangles: number;
      shadingVersion?: number;
    };
    try {
      result = await this.request('raster3d', request);
    } catch (e) {
      if (
        e instanceof VmotionError &&
        e.code === 'NATIVE_ERROR' &&
        e.message.includes('Unknown method')
      )
        return rasterize3D(request);
      throw e;
    }
    if (request.lighting && result.shadingVersion !== 1) return rasterize3D(request);
    const pixels = Buffer.from(result.rgba, 'base64'),
      size = request.width * request.height;
    if (pixels.length !== size * 4)
      throw new VmotionError('RASTER3D_OUTPUT', 'Native pixel buffer size mismatch');
    const floats = (data: string) => {
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length !== size * 4)
          throw new VmotionError('RASTER3D_OUTPUT', 'Native depth buffer size mismatch');
        const out = new Float32Array(size);
        for (let i = 0; i < size; i++) out[i] = bytes.readFloatLE(i * 4);
        return out;
      },
      ints = (data: string) => {
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length !== size * 4)
          throw new VmotionError('RASTER3D_OUTPUT', 'Native ID buffer size mismatch');
        const out = new Int32Array(size);
        for (let i = 0; i < size; i++) out[i] = bytes.readInt32LE(i * 4);
        return out;
      };
    if (request.inspection && (!result.depth || !result.faceIds))
      throw new VmotionError('RASTER3D_OUTPUT', 'Native inspection buffers are missing');
    return {
      pixels,
      backend: 'rust',
      triangles: result.triangles,
      ...(request.inspection
        ? { depth: floats(result.depth!), faceIds: ints(result.faceIds!) }
        : {}),
    };
  }
  private request<T>(method: string, payload: object): Promise<T> {
    const id = ++this.counter,
      line = JSON.stringify({ id, method, ...payload });
    if (Buffer.byteLength(line) > 16 * 1024 * 1024)
      return Promise.reject(
        new VmotionError(
          'NATIVE_INPUT_LIMIT',
          'Native request exceeds 16MB; split or simplify geometry',
        ),
      );
    if (!this.child) {
      this.child = spawn(this.binary, [], { windowsHide: true });
      this.child.stderr.on('data', () => {});
      this.child.on('error', (e) => this.fail(e));
      this.child.on('exit', () =>
        this.fail(new VmotionError('NATIVE_EXIT', 'Native animation core exited')),
      );
      this.child.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString();
        let end;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const raw = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          try {
            const message = JSON.parse(raw),
              request = this.pending.get(message.id);
            if (!request) continue;
            this.pending.delete(message.id);
            if (message.error)
              request.reject(
                new VmotionError(
                  message.error.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? 'NATIVE_ERROR',
                  message.error,
                ),
              );
            else request.resolve(message.result);
          } catch (e) {
            this.fail(e as Error);
          }
        }
      });
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(line + '\n');
    });
  }
  private fail(e: Error) {
    for (const value of this.pending.values()) value.reject(e);
    this.pending.clear();
    this.child = undefined;
  }
  close() {
    this.child?.kill();
    this.child = undefined;
  }
}
export function resolveNativeBinary(directory: string) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (
      typeof manifest.executable === 'string' &&
      path.basename(manifest.executable) === manifest.executable
    )
      return path.join(directory, manifest.executable);
  } catch {}
  return path.join(directory, process.platform === 'win32' ? 'vmotion-core.exe' : 'vmotion-core');
}
