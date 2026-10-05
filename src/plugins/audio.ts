import path from 'node:path';
import { z } from 'zod';
import {
  soundLibrary,
  soundLibrarySchema,
  inspectSound,
  soundInspectSchema,
  planSound,
  soundPlanSchema,
  previewSound,
  soundPreviewSchema,
  soundMidi,
  soundMidiSchema,
} from '../service/sound.js';
import {
  inspectAudioMix,
  audioMixInspectSchema,
  planAudioMix,
  audioMixPlanSchema,
  auditAudio,
  audioAuditSchema,
} from '../service/audio-mixing.js';
import { audioRangeSchema, audioMetrics } from '../media/audio-preview.js';
import { audioClips, AUDIO_SAMPLE_RATE, pcmWave, sampleAtFrame } from '../media/audio.js';
import { audioSourceFile } from '../media/sound-source.js';
import { waveform } from '../media/ffmpeg.js';
import { analyzeAudio } from '../media/analysis.js';
import { atomicWrite, safePath } from '../service/project.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { BuiltinPluginHost, BuiltinPluginModule } from './types.js';

export const audioTimelineSchema = z
  .object({
    sequenceId: z.string().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(24),
    includeAll: z.boolean().default(false),
  })
  .strict();

export function inspectAudioTimeline(snapshot: Snapshot, raw: unknown) {
  const request = audioTimelineSchema.parse(raw),
    sequenceId = request.sequenceId ?? snapshot.project.activeSequence,
    clips = audioClips(snapshot, sequenceId),
    sequence = snapshot.sequences.find((s) => s.id === sequenceId)!;
  const offset = request.includeAll ? 0 : request.offset,
    page = request.includeAll ? clips : clips.slice(offset, offset + request.limit);
  return {
    revision: snapshot.revision,
    sequenceId,
    sampleRate: AUDIO_SAMPLE_RATE,
    durationSamples: sampleAtFrame(sequence.duration, snapshot.project.fps),
    clips: page.map((clip) => ({
      ...clip,
      asset: {
        id: clip.asset.id,
        name: clip.asset.name,
        type: clip.asset.type,
        path: clip.asset.path,
      },
      startSample: sampleAtFrame(clip.start, snapshot.project.fps),
      endSample: sampleAtFrame(clip.start + clip.duration, snapshot.project.fps),
    })),
    totalClips: clips.length,
    offset,
    returned: page.length,
    nextOffset: offset + page.length < clips.length ? offset + page.length : undefined,
    full: request.includeAll,
  };
}

async function sourceFile(host: BuiltinPluginHost, id: string) {
  const asset = host.snapshot.project.assets.find((asset) => asset.id === id);
  if (!asset) throw new VmotionError('NOT_FOUND', 'Asset not found');
  return audioSourceFile(host.root, host.snapshot, asset);
}

export const audioPlugin: BuiltinPluginModule = {
  id: 'vmotion.audio',
  name: '声音与音乐',
  version: '1.0.0',
  dependencies: { 'vmotion.media': '^1.0.0' },
  methods: new Set([
    'soundLibrary',
    'soundInspect',
    'soundPlan',
    'soundPreview',
    'soundMidi',
    'audioMixInspect',
    'audioMixPlan',
    'audioAudit',
    'audioTimeline',
    'audioPreview',
    'waveform',
    'audioAnalyze',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'audio_mix_inspect',
        method: 'audioMixInspect',
        schema: audioMixInspectSchema.shape,
        description:
          'Inspect timeline track/bus/master routing, effects, gain/pan, sidechain dependencies and normalization settings with selected node IDs and optional full configuration. Declared graph rejects feedback cycles. Ordinary audio preview/export uses the same full-history mix cache.',
      },
      {
        name: 'audio_mix_plan',
        method: 'audioMixPlan',
        schema: audioMixPlanSchema.shape,
        description:
          'Plan multi-sequence track/bus/master mixing, sidechain ducking, gain/pan automation and measured loudness normalization as an exact atomic candidate. Stable track/bus actions, locked-track checks, explicit scratch budgets and source fingerprints preserve safety/undo. Audition audio_preview planId and measure audio_audit before applying unchanged.',
      },
      {
        name: 'audio_audit',
        method: 'audioAudit',
        schema: audioAuditSchema.shape,
        description:
          'Measure actual sequence or audio/video/sound asset PCM through FFmpeg EBU R128/BS.1770: integrated LUFS, LRA and true peak with profile findings, whole/range coverage and bounded cached evidence. Supports exact stored candidates. Silence/short ranges report uncertainty; encoded lossy deliveries should be audited separately.',
      },
      {
        name: 'sound_library',
        method: 'soundLibrary',
        schema: soundLibrarySchema.shape,
        description:
          'Discover local synth/FM/noise/drum/sample instruments and gain/EQ/distortion/delay/chorus/reverb/compressor/limiter effects, units, budgets and the agent music workflow. No AI calls or external instrument plugins. Full interfaces use project_schema sound/soundInstrument/soundEffect.',
      },
      {
        name: 'sound_inspect',
        method: 'soundInspect',
        schema: soundInspectSchema.shape,
        description:
          'Inspect an editable JSON sound asset: tempo map, duration/sample positions, note events by stable IDs with paging, instruments, automation and acyclic bus/send order. Optional full document for code authoring. Audio rendering and sample evidence use sound_preview.',
      },
      {
        name: 'sound_plan',
        method: 'soundPlan',
        schema: soundPlanSchema.shape,
        description:
          'Create or edit multi-track music and sound effects as an exact atomic candidate. Supports full documents or stable-ID track/note actions, transpose/quantize/duplicate, synth/FM/noise/drums/audio samples, beat/second clocks, gain/pan automation, effects and buses. Optional locked-track-aware timeline placement. Review sound_preview planId then project_preflight/project_apply unchanged for one undo; sample fingerprints are pinned.',
      },
      {
        name: 'sound_preview',
        method: 'soundPreview',
        schema: soundPreviewSchema.shape,
        description:
          'Audition 1–10 seconds of an editable sound asset or a stored candidate without applying it. Renders deterministic stereo 48 kHz from origin, retaining delay/reverb/compressor history when seeking; returns playable WAV, RMS/peak/waveform and full-mix clipping evidence. Project source is preserved, outputs are cache/export files.',
      },
      {
        name: 'sound_midi',
        method: 'soundMidi',
        schema: soundMidiSchema.shape,
        description:
          'Import standard MIDI format 0/1 PPQ as an editable sound candidate, or export notes/tempo to format 1 MIDI. Import supports tempo maps, velocity and sustain; maps GM to local presets and reports unsupported controls/plugins. Export explicitly reports processing/sampling/sweeps omitted from MIDI. Source MIDI is preserved.',
      },
      {
        name: 'audio_timeline',
        description:
          'Inspect paged audible sequence clips (24 by default), exact sample positions, source trims, nested speeds/volumes and fade envelopes. Muted tracks are excluded. Read totalClips/nextOffset for coverage; includeAll opts into the full timeline.',
        method: 'audioTimeline',
        schema: audioTimelineSchema.shape,
      },
      {
        name: 'audio_preview',
        description:
          'Render up to 10 seconds of the actual sequence audio mix at exact 48 kHz sample positions. Returns playable WAV audio plus waveform levels, RMS, peak and limiter sample ratio; uses the same mixer as export and checks project revision.',
        method: 'audioPreview',
        schema: { ...audioRangeSchema.shape, output: z.string().optional() },
      },
      {
        name: 'audio_waveform',
        description: 'Read bounded audio peak samples.',
        method: 'waveform',
        schema: { assetId: z.string() },
      },
      {
        name: 'audio_analyze',
        description:
          'Analyze a bounded local audio range (default 60s, maximum 600s) for RMS/peak, low/mid/high frequency bands and estimated onsets/BPM. Beat estimates are heuristic; components receive features through audioAssetId and ctx.audio in cached 30s windows.',
        method: 'audioAnalyze',
        schema: {
          assetId: z.string(),
          rate: z.number().int().min(5).max(60).default(30),
          start: z.number().nonnegative().default(0),
          duration: z.number().positive().max(600).default(60),
        },
      },
    ];
  },
  async dispatch(host, method, params) {
    const snapshot = host.snapshot;
    switch (method) {
      case 'soundLibrary':
        return soundLibrary(params);
      case 'soundInspect':
        return inspectSound(snapshot, params);
      case 'soundPlan':
        return planSound(host.root, structuredClone(snapshot), params);
      case 'soundMidi':
        return soundMidi(host.root, structuredClone(snapshot), params);
      case 'soundPreview': {
        const request = soundPreviewSchema.parse(params),
          candidate = await host.candidateSnapshot(request);
        return host.withMediaTask(() =>
          previewSound(host.root, candidate, { ...request, revision: candidate.revision }),
        );
      }
      case 'audioMixInspect':
        return inspectAudioMix(snapshot, params);
      case 'audioMixPlan':
        return planAudioMix(host.root, structuredClone(snapshot), params);
      case 'audioAudit': {
        const candidate = await host.candidateSnapshot(params);
        return host.withMediaTask(() =>
          auditAudio(host.root, candidate, { ...params, revision: candidate.revision }),
        );
      }
      case 'audioTimeline':
        return inspectAudioTimeline(snapshot, params);
      case 'audioPreview': {
        const candidate = await host.candidateSnapshot(params),
          { output, inline, planId, ...request } = params;
        return host.withMediaTask(async () => {
          const result = await host.audioPreview.range(candidate, {
              ...request,
              revision: candidate.revision,
            }),
            file = path.resolve(
              output ??
                safePath(
                  host.root,
                  `.vmotion/audio-preview/${result.revision}-${result.sequenceId}-${result.startSample}.wav`,
                ),
            ),
            buffer = pcmWave(result.buffer),
            metrics = audioMetrics(result.buffer);
          await atomicWrite(file, buffer);
          return {
            output: file,
            revision: result.revision,
            sequenceId: result.sequenceId,
            startSample: result.startSample,
            sampleCount: result.sampleCount,
            sampleRate: result.sampleRate,
            channels: result.channels,
            duration: result.duration,
            clipCount: result.clipCount,
            metrics,
            mimeType: 'audio/wav',
            ...(inline ? { data: buffer.toString('base64') } : {}),
          };
        });
      }
      case 'waveform':
        return host.withMediaTask(async () => waveform(await sourceFile(host, params.assetId)));
      case 'audioAnalyze': {
        if (params.duration !== undefined && (params.duration <= 0 || params.duration > 600))
          throw new VmotionError(
            'ANALYSIS_RANGE',
            'Request at most 600 seconds of audio per analysis call',
          );
        return host.withMediaTask(async () => {
          const analysis = await analyzeAudio(await sourceFile(host, params.assetId), {
            rate: params.rate,
            start: params.start,
            duration: params.duration ?? 60,
          });
          return { assetId: params.assetId, ...analysis };
        });
      }
      default:
        throw new VmotionError('METHOD_NOT_FOUND', 'Audio module does not handle this method', {
          method,
        });
    }
  },
};
