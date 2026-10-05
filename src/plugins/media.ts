import { mediaStatusSchema, mediaStatus } from '../service/media-management.js';
import {
  mediaInspectSchema,
  mediaSampleSchema,
  inspectMedia,
  sampleMedia,
} from '../service/media-evidence.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { Snapshot } from '../core/model.js';

export const mediaPlugin = {
  id: 'vmotion.media',
  name: '媒体素材与取证',
  version: '1.0.0',
  methods: new Set(['mediaStatus', 'mediaInspect', 'mediaSample']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'media_status',
        method: 'mediaStatus',
        schema: mediaStatusSchema.shape,
        description:
          'Inspect paged asset availability, registered metadata and ready/stale proxies without dumping project source. Missing files remain identified by stable IDs for relink candidates.',
        plugin: { id: 'vmotion.media', version: '1.0.0', origin: 'builtin' as const },
        categories: ['media'],
        keywords: '素材 媒体 缺失 代理 状态 文件',
      },
      {
        name: 'media_inspect',
        method: 'mediaInspect',
        schema: mediaInspectSchema.shape,
        description:
          'Probe actual source metadata, dimensions, audio streams, project-frame range and fingerprint. Return asset evidence for checked planning and commits.',
        plugin: { id: 'vmotion.media', version: '1.0.0', origin: 'builtin' as const },
        categories: ['media', 'editing'],
        keywords: '素材 视频 音频 图片 元数据 时长 指纹',
      },
      {
        name: 'media_sample',
        method: 'mediaSample',
        schema: mediaSampleSchema.omit({ inline: true }).shape,
        description:
          'Inspect video/image/drawing source frames before editing. Returns bounded native contact images, source-frame units, pixel hashes and asset evidence without changing the project.',
        plugin: { id: 'vmotion.media', version: '1.0.0', origin: 'builtin' as const },
        categories: ['media', 'editing'],
        keywords: '素材 取证 帧 采样 接触表 图片 视频',
      },
    ];
  },
  dispatch(root: string, snapshot: Snapshot, method: string, params: unknown) {
    if (method === 'mediaStatus') return mediaStatus(root, snapshot, params);
    if (method === 'mediaInspect') return inspectMedia(root, structuredClone(snapshot), params);
    return sampleMedia(root, structuredClone(snapshot), params);
  },
};
