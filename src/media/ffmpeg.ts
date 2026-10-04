import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { VmotionError } from '../core/model.js';
export const ffmpegBinary = () => process.env.VMOTION_FFMPEG ?? 'ffmpeg';
export const ffprobeBinary = () => process.env.VMOTION_FFPROBE ?? 'ffprobe';
export async function runProcess(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, signal });
    const chunks: Buffer[] = [];
    let stderr = '',
      bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024 * 1024) {
        child.kill();
        reject(new VmotionError('PROCESS_OUTPUT_LIMIT', 'Process output exceeds 128MB'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on(
      'data',
      (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-16000)),
    );
    child.on('error', (e) => reject(new VmotionError('MEDIA_PROCESS', `${binary}: ${e.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(
            new VmotionError(
              signal?.aborted ? 'CANCELLED' : 'MEDIA_PROCESS',
              `${binary} exited ${code}: ${stderr}`,
            ),
          ),
    );
  });
}
export async function probe(file: string) {
  const raw = await runProcess(ffprobeBinary(), [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(raw.toString()) as {
    format: { duration?: string };
    streams: Array<{
      codec_type: string;
      width?: number;
      height?: number;
      sample_rate?: string;
      channels?: number;
      channel_layout?: string;
      duration?: string;
    }>;
  };
}
export async function fingerprint(file: string) {
  const s = await stat(file);
  return `${s.size}:${s.mtimeMs}`;
}
export async function waveform(file: string, samples = 500) {
  const info = await probe(file),
    duration = Number(
      info.format.duration ?? info.streams.find((s) => s.codec_type === 'audio')?.duration,
    );
  if (!Number.isFinite(duration) || duration <= 0)
    throw new VmotionError('MEDIA_DURATION', 'Cannot determine audio duration');
  if (!info.streams.some((s) => s.codec_type === 'audio'))
    throw new VmotionError('NO_AUDIO', 'This asset has no audio stream');
  samples = Math.max(1, Math.min(2000, Math.floor(samples)));
  const bin = Math.max(1, Math.ceil((duration * 48000) / samples)),
    peaks: number[] = [];
  let pending = Buffer.alloc(0),
    position = 0,
    stderr = '';
  const child = spawn(
    ffmpegBinary(),
    ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { windowsHide: true },
  );
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk.toString()).slice(-8000)));
  const closed = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new VmotionError('WAVEFORM_DECODE', stderr || `Decoder exited ${code}`)),
    );
  });
  closed.catch(() => {});
  try {
    for await (const chunk of child.stdout) {
      const bytes = Buffer.concat([pending, chunk]),
        complete = Math.floor(bytes.length / 8) * 8;
      for (let offset = 0; offset < complete; offset += 8) {
        const index = Math.min(samples - 1, Math.floor(position++ / bin)),
          peak = Math.max(
            Math.abs(bytes.readFloatLE(offset)),
            Math.abs(bytes.readFloatLE(offset + 4)),
          );
        if (Number.isFinite(peak)) peaks[index] = Math.max(peaks[index] ?? 0, peak);
      }
      pending = bytes.subarray(complete);
    }
    await closed;
    return peaks;
  } catch (e) {
    child.kill();
    throw e;
  }
}
export async function proxy(file: string, output: string, signal?: AbortSignal) {
  await runProcess(
    ffmpegBinary(),
    [
      '-y',
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      'scale=960:-2',
      '-c:v',
      'mpeg4',
      '-q:v',
      '5',
      '-c:a',
      'aac',
      output,
    ],
    signal,
  );
  return output;
}

export class VideoDecoder {
  private child?: ChildProcessWithoutNullStreams;
  private iterator?: AsyncIterator<Buffer>;
  private pending = Buffer.alloc(0);
  private current = -1;
  private stderr = '';
  private frames = new Map<number, Buffer>();
  private frameBytes = 0;
  constructor(
    private file: string,
    private width: number,
    private height: number,
    private fps: { num: number; den: number },
  ) {}
  async frame(index: number) {
    index = Math.max(0, Math.floor(index));
    const cached = this.frames.get(index);
    if (cached) {
      this.frames.delete(index);
      this.frames.set(index, cached);
      return cached;
    }
    if (!this.child || index <= this.current || index > this.current + 5) this.start(index);
    while (this.current < index) {
      const size = this.width * this.height * 4;
      while (this.pending.length < size) {
        const part = await this.iterator!.next();
        if (part.done)
          throw new VmotionError(
            'VIDEO_DECODE',
            `Cannot decode frame ${index} of ${this.file}: ${this.stderr}`,
          );
        this.pending = Buffer.concat([this.pending, part.value]);
      }
      const pixels = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      this.current++;
      const copy = Buffer.from(pixels);
      const budget = 48 * 1024 * 1024;
      while (
        this.frames.size &&
        (this.frames.size >= 8 || this.frameBytes + copy.length > budget)
      ) {
        const first = this.frames.keys().next().value!,
          old = this.frames.get(first)!;
        this.frames.delete(first);
        this.frameBytes -= old.length;
      }
      if (copy.length <= budget) {
        this.frames.set(this.current, copy);
        this.frameBytes += copy.length;
      }
      if (this.current === index) return copy;
    }
    throw new Error('Invalid decoder state');
  }
  private start(index: number) {
    this.close(false);
    this.stderr = '';
    this.pending = Buffer.alloc(0);
    this.current = index - 1;
    const time = (index * this.fps.den) / this.fps.num;
    this.child = spawn(
      ffmpegBinary(),
      [
        '-v',
        'error',
        '-ss',
        time.toFixed(9),
        '-i',
        this.file,
        '-an',
        '-vf',
        `fps=${this.fps.num}/${this.fps.den},scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
        '-pix_fmt',
        'rgba',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { windowsHide: true },
    );
    this.child.on('error', (e) => {
      this.stderr = e.message;
    });
    this.child.stderr.on(
      'data',
      (chunk) => (this.stderr = (this.stderr + chunk.toString()).slice(-8000)),
    );
    this.iterator = this.child.stdout[Symbol.asyncIterator]();
  }
  close(clearFrames = true) {
    this.child?.kill();
    this.child = undefined;
    this.iterator = undefined;
    this.pending = Buffer.alloc(0);
    if (clearFrames) {
      this.frames.clear();
      this.frameBytes = 0;
    }
  }
}
