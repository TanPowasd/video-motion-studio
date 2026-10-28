import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { VmotionError, sceneSchema, type Node, type Scene, type Snapshot } from './model.js';

export const SLIDE_LAYOUT_IDS = [
  'title-cover',
  'section-header',
  'bullet-points',
  'two-column',
  'image-split',
  'metrics-grid',
  'quote',
  'code-walkthrough',
  'comparison-table',
  'closing',
] as const;

export const slideLayoutIdSchema = z.enum(SLIDE_LAYOUT_IDS);
export type SlideLayoutId = z.infer<typeof slideLayoutIdSchema>;

export const slideMetricSchema = z
  .object({
    label: z.string().min(1).max(120),
    value: z.string().min(1).max(80),
    delta: z.string().max(80).optional(),
  })
  .strict();
export type SlideMetric = z.infer<typeof slideMetricSchema>;

export const slideTableSchema = z
  .object({
    headers: z.array(z.string().max(160)).min(1).max(8),
    rows: z.array(z.array(z.string().max(240)).min(1).max(8)).min(1).max(12),
  })
  .strict();
export type SlideTable = z.infer<typeof slideTableSchema>;

export const slideColumnSchema = z
  .object({
    heading: z.string().max(160).optional(),
    bullets: z.array(z.string().max(400)).max(10).default([]),
  })
  .strict();
export type SlideColumn = z.infer<typeof slideColumnSchema>;

export const slideTransitionSchema = z
  .object({
    type: z.enum(['none', 'fade', 'slide-up']).default('fade'),
    durationFrames: z.number().int().min(0).max(120).default(12),
  })
  .strict();
export type SlideTransition = z.infer<typeof slideTransitionSchema>;

export const slideThemeSchema = z
  .object({
    id: z.string().min(1).max(80).default('editorial-dark'),
    background: z.string().min(1).default('#0d1322'),
    surface: z.string().min(1).default('#162038'),
    primary: z.string().min(1).default('#f8fafc'),
    secondary: z.string().min(1).default('#94a3b8'),
    accent: z.string().min(1).default('#38bdf8'),
    accentSoft: z.string().min(1).default('#1e293b'),
    fontTitle: z.string().min(1).default('Microsoft YaHei'),
    fontBody: z.string().min(1).default('Microsoft YaHei'),
    fontMono: z.string().min(1).default('Consolas'),
  })
  .strict();
export type SlideTheme = z.infer<typeof slideThemeSchema>;

export const SLIDE_THEME_PRESETS: Record<string, SlideTheme> = {
  'editorial-dark': {
    id: 'editorial-dark',
    background: '#0d1322',
    surface: '#162038',
    primary: '#f8fafc',
    secondary: '#94a3b8',
    accent: '#38bdf8',
    accentSoft: '#1e293b',
    fontTitle: 'Microsoft YaHei',
    fontBody: 'Microsoft YaHei',
    fontMono: 'Consolas',
  },
  'executive-light': {
    id: 'executive-light',
    background: '#f8fafc',
    surface: '#ffffff',
    primary: '#0f172a',
    secondary: '#475569',
    accent: '#2563eb',
    accentSoft: '#e2e8f0',
    fontTitle: 'Microsoft YaHei',
    fontBody: 'Microsoft YaHei',
    fontMono: 'Consolas',
  },
  'emerald-tech': {
    id: 'emerald-tech',
    background: '#071714',
    surface: '#0f2922',
    primary: '#ecfdf5',
    secondary: '#a7f3d0',
    accent: '#10b981',
    accentSoft: '#13382e',
    fontTitle: 'Microsoft YaHei',
    fontBody: 'Microsoft YaHei',
    fontMono: 'Consolas',
  },
  'sunset-keynote': {
    id: 'sunset-keynote',
    background: '#18101c',
    surface: '#271a2e',
    primary: '#fff7ed',
    secondary: '#fdba74',
    accent: '#f97316',
    accentSoft: '#39223c',
    fontTitle: 'Microsoft YaHei',
    fontBody: 'Microsoft YaHei',
    fontMono: 'Consolas',
  },
};

export const slideSpecSchema = z
  .object({
    id: z.string().min(1).max(120),
    sceneId: z.string().min(1).max(160).optional(),
    layout: slideLayoutIdSchema.default('bullet-points'),
    badge: z.string().max(80).optional(),
    title: z.string().min(1).max(300),
    subtitle: z.string().max(500).optional(),
    bullets: z.array(z.string().max(500)).max(12).default([]),
    left: slideColumnSchema.optional(),
    right: slideColumnSchema.optional(),
    metrics: z.array(slideMetricSchema).max(6).default([]),
    quote: z.string().max(800).optional(),
    attribution: z.string().max(200).optional(),
    code: z.string().max(4000).optional(),
    codeLanguage: z.string().max(40).optional(),
    table: slideTableSchema.optional(),
    mediaAssetId: z.string().max(200).optional(),
    footer: z.string().max(200).optional(),
    notes: z.string().max(4000).default(''),
    chapter: z.string().max(120).optional(),
    durationFrames: z.number().int().min(15).max(36000).default(150),
    animateEntrance: z.boolean().default(true),
    transition: slideTransitionSchema.default({ type: 'fade', durationFrames: 12 }),
  })
  .strict();
export type SlideSpec = z.infer<typeof slideSpecSchema>;

export const slideDeckDocumentSchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    sequenceId: z.string().min(1).max(160),
    videoTrackId: z.string().min(1).max(160),
    theme: slideThemeSchema.default(SLIDE_THEME_PRESETS['editorial-dark']),
    slides: z.array(slideSpecSchema).min(1).max(200),
  })
  .strict();
export type SlideDeckDocument = z.infer<typeof slideDeckDocumentSchema>;

export interface ParsedPptxMedia {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

export interface ParsedPptxResult {
  title: string;
  widthPx: number;
  heightPx: number;
  slides: SlideSpec[];
  media: Map<string, ParsedPptxMedia>;
}

const EMU_PER_PIXEL = 9525; // 914400 EMU/inch / 96 px/inch
const FIXED_ZIP_MTIME = new Date('2026-01-01T00:00:00.000Z');

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function localName(node: { nodeName?: string; localName?: string | null }): string {
  if (node.localName) return node.localName;
  const name = node.nodeName ?? '';
  const idx = name.indexOf(':');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function childElements(parent: any, name?: string): any[] {
  const out: any[] = [];
  if (!parent?.childNodes) return out;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType === 1 && (!name || localName(child) === name)) {
      out.push(child);
    }
  }
  return out;
}

function descendantElements(root: any, name: string): any[] {
  const out: any[] = [];
  function visit(node: any) {
    if (!node?.childNodes) return;
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType === 1) {
        if (localName(child) === name) out.push(child);
        visit(child);
      }
    }
  }
  visit(root);
  return out;
}

function attr(el: any, name: string): string | undefined {
  if (!el?.attributes) return undefined;
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.name === name || localName(a) === name) return a.value;
  }
  return undefined;
}

function extractParagraphs(container: any): Array<{ text: string; level: number }> {
  const paragraphs = descendantElements(container, 'p');
  const result: Array<{ text: string; level: number }> = [];
  for (const p of paragraphs) {
    const pPr = childElements(p, 'pPr')[0];
    const lvlStr = pPr ? attr(pPr, 'lvl') : undefined;
    const level = lvlStr ? Math.max(0, Math.min(4, Number.parseInt(lvlStr, 10) || 0)) : 0;
    const runs = descendantElements(p, 't');
    const text = runs
      .map((t) => t.textContent ?? '')
      .join('')
      .trim();
    if (text.length > 0) {
      result.push({ text, level });
    }
  }
  return result;
}

function normalizePosixPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = [...baseDir.split('/').filter(Boolean), ...target.split('/').filter(Boolean)];
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function parseRelationships(xmlText: string | undefined, baseDir: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  if (!xmlText) return map;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  for (const rel of descendantElements(doc, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    const type = attr(rel, 'Type') ?? '';
    if (id && target) {
      map.set(id, { target: normalizePosixPath(baseDir, target), type });
    }
  }
  return map;
}

/**
 * Estimate speaking duration in frames from slide text and speaker notes.
 */
export function estimateSlideDurationFrames(
  slide: Pick<SlideSpec, 'title' | 'subtitle' | 'bullets' | 'notes' | 'quote' | 'left' | 'right'>,
  fpsNum = 30,
  fpsDen = 1,
): number {
  const fps = Math.max(1, fpsNum / fpsDen);
  const textSource =
    slide.notes.trim().length > 0
      ? slide.notes.trim()
      : [
          slide.title,
          slide.subtitle ?? '',
          ...(slide.bullets ?? []),
          slide.quote ?? '',
          ...(slide.left?.bullets ?? []),
          ...(slide.right?.bullets ?? []),
        ]
          .join(' ')
          .trim();
  // Count CJK characters + English words (~3.8 units/sec speaking rate)
  const cjkCount = (textSource.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const nonCjkWords = textSource
    .replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  const units = cjkCount + nonCjkWords;
  const seconds = Math.max(3, Math.min(45, 2 + units / 3.8));
  return Math.max(30, Math.round(seconds * fps));
}

/**
 * Compute readability & layout diagnostics for a slide.
 */
export function analyzeSlideReadability(slide: SlideSpec) {
  const bulletCount =
    slide.bullets.length +
    (slide.left?.bullets.length ?? 0) +
    (slide.right?.bullets.length ?? 0);
  const charCount =
    slide.title.length +
    (slide.subtitle?.length ?? 0) +
    slide.bullets.reduce((acc, b) => acc + b.length, 0) +
    (slide.quote?.length ?? 0) +
    (slide.code?.length ?? 0);
  const warnings: string[] = [];
  if (slide.title.length > 72) {
    warnings.push('Title exceeds 72 characters and may wrap past 2 lines');
  }
  if (bulletCount > 7) {
    warnings.push(`Slide has ${bulletCount} bullet points; consider splitting across two slides`);
  }
  if (slide.bullets.some((b) => b.length > 140)) {
    warnings.push('One or more bullet points exceed 140 characters');
  }
  if (slide.layout === 'code-walkthrough' && (slide.code?.split('\n').length ?? 0) > 16) {
    warnings.push('Code block exceeds 16 lines and may clip on 1080p canvas');
  }
  return {
    bulletCount,
    charCount,
    hasNotes: slide.notes.trim().length > 0,
    overflowRisk: warnings.length > 0,
    warnings,
  };
}

/**
 * Deterministically parse a `.pptx` (OpenXML ZIP) buffer into structured `SlideSpec[]` and extracted media.
 */
export function parsePptxBuffer(
  buffer: Uint8Array,
  options: { fpsNum?: number; fpsDen?: number; defaultDurationFrames?: number } = {},
): ParsedPptxResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buffer);
  } catch (err) {
    throw new VmotionError('PPTX_INVALID', `Failed to unzip .pptx archive: ${(err as Error).message}`);
  }
  const readXml = (path: string): string | undefined => {
    const entry = files[path];
    return entry ? strFromU8(entry) : undefined;
  };
  const presXml = readXml('ppt/presentation.xml');
  if (!presXml || !files['[Content_Types].xml']) {
    throw new VmotionError(
      'PPTX_INVALID',
      'Archive is missing ppt/presentation.xml or [Content_Types].xml',
    );
  }

  const parser = new DOMParser();
  const presDoc = parser.parseFromString(presXml, 'application/xml');
  const sldSz = descendantElements(presDoc, 'sldSz')[0];
  const cxEmu = Number.parseInt(attr(sldSz, 'cx') ?? '12192000', 10);
  const cyEmu = Number.parseInt(attr(sldSz, 'cy') ?? '6858000', 10);
  const rawW = Math.round(cxEmu / EMU_PER_PIXEL);
  const rawH = Math.round(cyEmu / EMU_PER_PIXEL);
  // Normalize standard 16:9 (1280x720 in 96dpi EMU) up to 1920x1080 HD if appropriate
  const widthPx = rawW === 1280 && rawH === 720 ? 1920 : Math.max(320, Math.min(3840, rawW || 1920));
  const heightPx = rawW === 1280 && rawH === 720 ? 1080 : Math.max(240, Math.min(2160, rawH || 1080));

  const presRels = parseRelationships(readXml('ppt/_rels/presentation.xml.rels'), 'ppt');
  const sldIds = descendantElements(presDoc, 'sldId');
  const slidePaths: string[] = [];
  for (const sldId of sldIds) {
    const rId = attr(sldId, 'r:id') ?? attr(sldId, 'id');
    const target = rId ? presRels.get(rId)?.target : undefined;
    if (target && files[target]) slidePaths.push(target);
  }
  if (slidePaths.length === 0) {
    slidePaths.push(
      ...Object.keys(files)
        .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    );
  }
  if (slidePaths.length === 0) {
    throw new VmotionError('PPTX_EMPTY', 'No slides found inside .pptx archive');
  }

  const media = new Map<string, ParsedPptxMedia>();
  const slides: SlideSpec[] = [];

  for (let i = 0; i < slidePaths.length; i++) {
    const slidePath = slidePaths[i];
    const slideNo = String(i + 1).padStart(2, '0');
    const slideId = `slide-${slideNo}`;
    const slideDir = slidePath.slice(0, slidePath.lastIndexOf('/'));
    const slideName = slidePath.slice(slidePath.lastIndexOf('/') + 1);
    const relsPath = `${slideDir}/_rels/${slideName}.rels`;
    const slideRels = parseRelationships(readXml(relsPath), slideDir);
    const slideDoc = parser.parseFromString(readXml(slidePath)!, 'application/xml');

    // Extract speaker notes if linked
    let notesText = '';
    let explicitLayout: SlideLayoutId | undefined;
    for (const rel of slideRels.values()) {
      if (rel.type.endsWith('/notesSlide') && files[rel.target]) {
        const notesDoc = parser.parseFromString(readXml(rel.target)!, 'application/xml');
        const notesShapes = descendantElements(notesDoc, 'sp');
        const paragraphs: string[] = [];
        for (const sp of notesShapes) {
          const ph = descendantElements(sp, 'ph')[0];
          const phType = attr(ph, 'type');
          if (phType === 'sldNum' || phType === 'hdr' || phType === 'ftr') continue;
          for (const p of extractParagraphs(sp)) {
            if (/^\d+$/.test(p.text)) continue;
            const layoutMatch = p.text.match(/^\[vmotion:layout=([a-z-]+)\]$/);
            if (layoutMatch && (SLIDE_LAYOUT_IDS as readonly string[]).includes(layoutMatch[1])) {
              explicitLayout = layoutMatch[1] as SlideLayoutId;
              continue;
            }
            paragraphs.push(p.text);
          }
        }
        notesText = paragraphs.join('\n').trim();
      }
    }

    // Extract shapes, placeholders, text boxes, tables, and pictures
    let title = '';
    let subtitle = '';
    let footer = '';
    let badge = '';
    const bodyBlocks: Array<{ x: number; y: number; paragraphs: Array<{ text: string; level: number }> }> = [];

    for (const sp of descendantElements(slideDoc, 'sp')) {
      const ph = descendantElements(sp, 'ph')[0];
      const phType = attr(ph, 'type') ?? '';
      const off = descendantElements(sp, 'off')[0];
      const x = Number.parseInt(attr(off, 'x') ?? '0', 10);
      const y = Number.parseInt(attr(off, 'y') ?? '0', 10);
      const paras = extractParagraphs(sp);
      if (paras.length === 0) continue;

      const joined = paras.map((p) => p.text).join(' ');
      const cNvPr = descendantElements(sp, 'cNvPr')[0];
      const shapeName = (attr(cNvPr, 'name') ?? '').toLowerCase();

      if (shapeName.startsWith('vmotion-badge') && !badge) {
        badge = joined;
        continue;
      }
      if ((phType === 'ftr' || shapeName.startsWith('vmotion-footer')) && !footer) {
        footer = joined;
        continue;
      }
      if (
        (phType === 'title' || phType === 'ctrTitle' || shapeName.startsWith('vmotion-title')) &&
        !title
      ) {
        title = joined;
        continue;
      }
      if ((phType === 'subTitle' || shapeName.startsWith('vmotion-subtitle')) && !subtitle) {
        subtitle = joined;
        continue;
      }
      bodyBlocks.push({ x, y, paragraphs: paras });
    }

    // Extract tables (<a:tbl>)
    let parsedTable: SlideTable | undefined;
    const tbl = descendantElements(slideDoc, 'tbl')[0];
    if (tbl) {
      const trs = childElements(tbl, 'tr');
      const gridRows: string[][] = [];
      for (const tr of trs) {
        const rowCells = childElements(tr, 'tc').map((tc) =>
          extractParagraphs(tc)
            .map((p) => p.text)
            .join(' ')
            .trim(),
        );
        if (rowCells.length > 0) gridRows.push(rowCells);
      }
      if (gridRows.length >= 2) {
        parsedTable = {
          headers: gridRows[0],
          rows: gridRows.slice(1),
        };
      }
    }

    // Extract first embedded image (<p:pic>)
    let mediaAssetId: string | undefined;
    const pic = descendantElements(slideDoc, 'pic')[0];
    if (pic) {
      const blip = descendantElements(pic, 'blip')[0];
      const embedId = attr(blip, 'r:embed') ?? attr(blip, 'embed');
      const rel = embedId ? slideRels.get(embedId) : undefined;
      if (rel && files[rel.target]) {
        const ext = rel.target.slice(rel.target.lastIndexOf('.') + 1).toLowerCase();
        const assetId = `slide-media-${slideNo}`;
        mediaAssetId = assetId;
        media.set(assetId, {
          filename: `slide-${slideNo}.${ext || 'png'}`,
          mimeType: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png',
          data: files[rel.target],
        });
      }
    }

    // Sort body blocks top-to-bottom, left-to-right
    bodyBlocks.sort((a, b) => (Math.abs(a.y - b.y) > 400000 ? a.y - b.y : a.x - b.x));

    if (!title && bodyBlocks.length > 0) {
      const firstBlock = bodyBlocks.shift()!;
      title = firstBlock.paragraphs[0]?.text ?? `Slide ${i + 1}`;
      if (firstBlock.paragraphs.length > 1) {
        bodyBlocks.unshift({
          x: firstBlock.x,
          y: firstBlock.y,
          paragraphs: firstBlock.paragraphs.slice(1),
        });
      }
    }
    if (!title) title = `Slide ${i + 1}`;

    const allBodyParas = bodyBlocks.flatMap((b) => b.paragraphs);
    const bullets = allBodyParas.map((p) =>
      p.level > 0 ? `${'  '.repeat(p.level)}${p.text}` : p.text,
    );

    // Infer semantic layout
    let layout: SlideLayoutId = explicitLayout ?? 'bullet-points';
    let left: SlideColumn | undefined;
    let right: SlideColumn | undefined;
    let metrics: SlideMetric[] = [];
    let quote: string | undefined;
    let attribution: string | undefined;
    let code: string | undefined;

    if (!explicitLayout) {
      if (parsedTable) {
        layout = 'comparison-table';
      } else if (mediaAssetId) {
        layout = 'image-split';
      } else if (i === 0 && bullets.length <= 2) {
        layout = 'title-cover';
        if (!subtitle && bullets.length > 0) {
          subtitle = bullets.join(' · ');
          bullets.length = 0;
        }
      } else if (
        bodyBlocks.length === 2 &&
        Math.abs(bodyBlocks[0].x - bodyBlocks[1].x) > cxEmu * 0.25
      ) {
        layout = 'two-column';
      } else if (
        bullets.length >= 1 &&
        bullets.length <= 2 &&
        (bullets[0].startsWith('"') || bullets[0].startsWith('“'))
      ) {
        layout = 'quote';
      } else if (bullets.length === 0 && subtitle) {
        layout = i === slidePaths.length - 1 ? 'closing' : 'section-header';
      }
    }

    if (layout === 'two-column' && bodyBlocks.length >= 2) {
      const sortedByX = [...bodyBlocks].sort((a, b) => a.x - b.x);
      const leftParas = sortedByX[0].paragraphs.map((p) => p.text);
      const rightParas = sortedByX[1].paragraphs.map((p) => p.text);
      left = {
        heading: leftParas.length > 1 ? leftParas[0] : 'Column A',
        bullets: leftParas.length > 1 ? leftParas.slice(1) : leftParas,
      };
      right = {
        heading: rightParas.length > 1 ? rightParas[0] : 'Column B',
        bullets: rightParas.length > 1 ? rightParas.slice(1) : rightParas,
      };
    } else if (layout === 'quote') {
      quote = bullets[0] ?? subtitle ?? title;
      attribution = bullets[1] ?? footer;
    } else if (layout === 'code-walkthrough') {
      code = bullets.join('\n');
    } else if (layout === 'metrics-grid') {
      metrics = bullets.slice(0, 6).map((line, idx) => {
        if (line.includes('|')) {
          const parts = line.split('|').map((s) => s.trim());
          return {
            label: parts[0] || `Metric ${idx + 1}`,
            value: parts[1] || line,
            ...(parts[2] ? { delta: parts[2] } : {}),
          };
        }
        const colonMatch = line.match(/^([^:：]+)[:：]\s*(.+)$/);
        if (colonMatch) {
          const label = colonMatch[1].trim();
          const rest = colonMatch[2].trim();
          const parenMatch = rest.match(/^(.*?)\s*\(([^()]+)\)$/);
          if (parenMatch && parenMatch[1].trim()) {
            return {
              label,
              value: parenMatch[1].trim(),
              delta: parenMatch[2].trim(),
            };
          }
          return { label, value: rest };
        }
        return { label: `Metric ${idx + 1}`, value: line };
      });
    }

    const baseSlide: SlideSpec = {
      id: slideId,
      layout,
      ...(badge ? { badge } : {}),
      title: title.slice(0, 300),
      ...(subtitle ? { subtitle: subtitle.slice(0, 500) } : {}),
      bullets: bullets.slice(0, 12).map((b) => b.slice(0, 500)),
      ...(left ? { left } : {}),
      ...(right ? { right } : {}),
      metrics,
      ...(quote ? { quote } : {}),
      ...(attribution ? { attribution } : {}),
      ...(code ? { code } : {}),
      ...(parsedTable ? { table: parsedTable } : {}),
      ...(mediaAssetId ? { mediaAssetId } : {}),
      ...(footer ? { footer } : {}),
      notes: notesText,
      durationFrames:
        options.defaultDurationFrames ??
        estimateSlideDurationFrames(
          { title, subtitle, bullets, notes: notesText, quote, left, right },
          options.fpsNum ?? 30,
          options.fpsDen ?? 1,
        ),
      animateEntrance: true,
      transition: { type: 'fade', durationFrames: 12 },
    };
    slides.push(slideSpecSchema.parse(baseSlide));
  }

  return {
    title: slides[0]?.title || 'Presentation',
    widthPx,
    heightPx,
    slides,
    media,
  };
}

function makeEntranceAnimations(
  enabled: boolean,
  delayFrames: number,
  baseY: number,
  transition?: SlideTransition,
  totalDurationFrames?: number,
) {
  const isSlideUp = transition?.type === 'slide-up';
  if (!enabled && !isSlideUp) return [];
  const start = Math.max(0, delayFrames);
  const enterDuration = isSlideUp ? Math.max(14, Math.min(24, transition.durationFrames)) : 14;
  const end = start + enterDuration;
  const enterOffsetY = isSlideUp ? 64 : 24;
  const yKeys: Array<{
    frame: number;
    value: number;
    easing: 'easeOut' | 'easeIn' | 'hold';
  }> = [
    { frame: start, value: baseY + enterOffsetY, easing: 'easeOut' },
    { frame: end, value: baseY, easing: 'easeOut' },
  ];
  if (
    isSlideUp &&
    totalDurationFrames !== undefined &&
    transition.durationFrames > 0 &&
    totalDurationFrames > end + transition.durationFrames + 2
  ) {
    const exitStart = totalDurationFrames - transition.durationFrames;
    yKeys.push(
      { frame: exitStart, value: baseY, easing: 'easeIn' },
      { frame: totalDurationFrames, value: baseY - 48, easing: 'easeIn' },
    );
  }
  return [
    ...(enabled
      ? [
          {
            property: 'opacity',
            keys: [
              { frame: start, value: 0, easing: 'easeOut' as const },
              { frame: end, value: 1, easing: 'easeOut' as const },
            ],
          },
        ]
      : []),
    {
      property: 'y',
      keys: yKeys,
    },
  ];
}

/**
 * Generate a Vmotion `Scene` with clean, high-contrast typography and vector cards for a `SlideSpec`.
 */
export function buildSlideScene(
  slide: SlideSpec,
  theme: SlideTheme,
  index: number,
  total: number,
  width = 1920,
  height = 1080,
): Scene {
  const sceneId = slide.sceneId ?? slide.id;
  const nodes: Node[] = [];
  const padX = Math.round(width * 0.065);
  const padY = Math.round(height * 0.08);
  const contentW = width - padX * 2;
  const anim = slide.animateEntrance;

  const pushRect = (
    idSuffix: string,
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string,
    radius = 16,
    delay = 0,
  ) => {
    nodes.push({
      id: `${sceneId}/${idSuffix}`,
      name,
      type: 'rect',
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(w),
      height: Math.round(h),
      fill,
      radius,
      animations: makeEntranceAnimations(
        anim && delay > 0,
        delay,
        Math.round(y),
        slide.transition,
        slide.durationFrames,
      ),
    } as unknown as Node);
  };

  const pushText = (
    idSuffix: string,
    name: string,
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    opts: {
      fontSize: number;
      fontWeight?: number;
      fill?: string;
      fontFamily?: string;
      align?: 'left' | 'center' | 'right';
      whiteSpace?: 'normal' | 'pre' | 'pre-wrap';
      delay?: number;
    },
  ) => {
    if (!text) return;
    nodes.push({
      id: `${sceneId}/${idSuffix}`,
      name,
      type: 'text',
      text,
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(w),
      height: Math.round(h),
      fontSize: opts.fontSize,
      fontWeight: opts.fontWeight ?? 400,
      fill: opts.fill ?? theme.primary,
      fontFamily: opts.fontFamily ?? theme.fontBody,
      align: opts.align ?? 'left',
      ...(opts.whiteSpace ? { whiteSpace: opts.whiteSpace } : {}),
      animations: makeEntranceAnimations(
        anim,
        opts.delay ?? 0,
        Math.round(y),
        slide.transition,
        slide.durationFrames,
      ),
    } as unknown as Node);
  };

  // Top accent bar
  pushRect('accent-bar', 'Accent Bar', padX, padY - 22, 88, 6, theme.accent, 3, 0);

  if (slide.badge) {
    pushText('badge', 'Badge', slide.badge.toUpperCase(), padX, padY - 6, 480, 36, {
      fontSize: 20,
      fontWeight: 700,
      fill: theme.accent,
      fontFamily: theme.fontTitle,
      delay: 0,
    });
  }

  switch (slide.layout) {
    case 'title-cover': {
      const titleY = Math.round(height * 0.34);
      pushRect(
        'hero-card',
        'Hero Backdrop',
        padX,
        Math.round(height * 0.22),
        contentW,
        Math.round(height * 0.56),
        theme.surface,
        28,
        0,
      );
      pushText('title', 'Title', slide.title, padX + 72, titleY, contentW - 144, 150, {
        fontSize: 72,
        fontWeight: 700,
        fill: theme.primary,
        fontFamily: theme.fontTitle,
        delay: 2,
      });
      if (slide.subtitle) {
        pushText(
          'subtitle',
          'Subtitle',
          slide.subtitle,
          padX + 72,
          titleY + 150,
          contentW - 144,
          90,
          {
            fontSize: 34,
            fontWeight: 400,
            fill: theme.secondary,
            delay: 6,
          },
        );
      }
      break;
    }

    case 'section-header': {
      const titleY = Math.round(height * 0.38);
      pushText('title', 'Section Title', slide.title, padX, titleY, contentW, 130, {
        fontSize: 68,
        fontWeight: 700,
        fill: theme.primary,
        fontFamily: theme.fontTitle,
        delay: 2,
      });
      if (slide.subtitle) {
        pushText('subtitle', 'Section Subtitle', slide.subtitle, padX, titleY + 132, contentW, 80, {
          fontSize: 32,
          fill: theme.secondary,
          delay: 6,
        });
      }
      break;
    }

    case 'two-column': {
      pushText('title', 'Title', slide.title, padX, padY + 34, contentW, 84, {
        fontSize: 52,
        fontWeight: 700,
        fontFamily: theme.fontTitle,
        delay: 2,
      });
      const colTop = padY + 150;
      const gap = 40;
      const colW = Math.floor((contentW - gap) / 2);
      const colH = height - colTop - padY - 40;
      const leftCol = slide.left ?? {
        heading: 'Key Points',
        bullets: slide.bullets.slice(0, Math.ceil(slide.bullets.length / 2)),
      };
      const rightCol = slide.right ?? {
        heading: 'Details',
        bullets: slide.bullets.slice(Math.ceil(slide.bullets.length / 2)),
      };

      pushRect('col-left-card', 'Left Card', padX, colTop, colW, colH, theme.surface, 20, 4);
      pushRect(
        'col-right-card',
        'Right Card',
        padX + colW + gap,
        colTop,
        colW,
        colH,
        theme.surface,
        20,
        6,
      );

      if (leftCol.heading) {
        pushText('left-heading', 'Left Heading', leftCol.heading, padX + 36, colTop + 32, colW - 72, 48, {
          fontSize: 32,
          fontWeight: 700,
          fill: theme.accent,
          delay: 6,
        });
      }
      leftCol.bullets.forEach((b, idx) => {
        pushText(
          `left-bullet-${idx}`,
          `Left Bullet ${idx + 1}`,
          `• ${b}`,
          padX + 36,
          colTop + 104 + idx * 72,
          colW - 72,
          64,
          { fontSize: 28, fill: theme.primary, delay: 8 + idx * 3 },
        );
      });

      if (rightCol.heading) {
        pushText(
          'right-heading',
          'Right Heading',
          rightCol.heading,
          padX + colW + gap + 36,
          colTop + 32,
          colW - 72,
          48,
          { fontSize: 32, fontWeight: 700, fill: theme.accent, delay: 8 },
        );
      }
      rightCol.bullets.forEach((b, idx) => {
        pushText(
          `right-bullet-${idx}`,
          `Right Bullet ${idx + 1}`,
          `• ${b}`,
          padX + colW + gap + 36,
          colTop + 104 + idx * 72,
          colW - 72,
          64,
          { fontSize: 28, fill: theme.primary, delay: 10 + idx * 3 },
        );
      });
      break;
    }

    case 'image-split': {
      const splitW = Math.floor(contentW * 0.52);
      const mediaW = contentW - splitW - 48;
      const mediaX = padX + splitW + 48;
      const topY = padY + 34;
      pushText('title', 'Title', slide.title, padX, topY, splitW, 110, {
        fontSize: 50,
        fontWeight: 700,
        fontFamily: theme.fontTitle,
        delay: 2,
      });
      if (slide.subtitle) {
        pushText('subtitle', 'Subtitle', slide.subtitle, padX, topY + 114, splitW, 60, {
          fontSize: 28,
          fill: theme.secondary,
          delay: 4,
        });
      }
      const listStart = topY + (slide.subtitle ? 190 : 130);
      slide.bullets.slice(0, 6).forEach((b, idx) => {
        pushText(
          `bullet-${idx}`,
          `Bullet ${idx + 1}`,
          `• ${b}`,
          padX,
          listStart + idx * 82,
          splitW,
          72,
          { fontSize: 28, fill: theme.primary, delay: 6 + idx * 3 },
        );
      });
      pushRect(
        'media-frame',
        'Media Frame',
        mediaX,
        topY,
        mediaW,
        height - topY - padY - 40,
        theme.surface,
        24,
        4,
      );
      if (slide.mediaAssetId) {
        nodes.push({
          id: `${sceneId}/media-image`,
          name: 'Slide Image',
          type: 'image',
          assetId: slide.mediaAssetId,
          fit: 'contain',
          x: mediaX + 16,
          y: topY + 16,
          width: mediaW - 32,
          height: height - topY - padY - 72,
          animations: makeEntranceAnimations(
            anim,
            6,
            topY + 16,
            slide.transition,
            slide.durationFrames,
          ),
        } as unknown as Node);
      }
      break;
    }

    case 'metrics-grid': {
      pushText('title', 'Title', slide.title, padX, padY + 34, contentW, 84, {
        fontSize: 52,
        fontWeight: 700,
        fontFamily: theme.fontTitle,
        delay: 2,
      });
      const metrics: SlideMetric[] =
        slide.metrics.length > 0
          ? slide.metrics
          : slide.bullets.slice(0, 4).map((b, idx) => ({
              label: `Metric ${idx + 1}`,
              value: b,
            }));
      const cols = metrics.length <= 3 ? Math.max(1, metrics.length) : 3;
      const rows = Math.ceil(metrics.length / cols);
      const gridTop = padY + 150;
      const gap = 32;
      const cardW = Math.floor((contentW - gap * (cols - 1)) / cols);
      const cardH = Math.floor((height - gridTop - padY - 48 - gap * (rows - 1)) / Math.max(1, rows));
      metrics.forEach((m, idx) => {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        const cx = padX + c * (cardW + gap);
        const cy = gridTop + r * (cardH + gap);
        pushRect(`metric-card-${idx}`, `Metric Card ${idx + 1}`, cx, cy, cardW, cardH, theme.surface, 20, 4 + idx * 3);
        pushText(`metric-value-${idx}`, `Metric Value ${idx + 1}`, m.value, cx + 32, cy + 36, cardW - 64, 76, {
          fontSize: 56,
          fontWeight: 700,
          fill: theme.accent,
          fontFamily: theme.fontTitle,
          delay: 6 + idx * 3,
        });
        pushText(`metric-label-${idx}`, `Metric Label ${idx + 1}`, m.label, cx + 32, cy + 124, cardW - 64, 48, {
          fontSize: 26,
          fontWeight: 600,
          fill: theme.primary,
          delay: 7 + idx * 3,
        });
        if (m.delta) {
          pushText(`metric-delta-${idx}`, `Metric Delta ${idx + 1}`, m.delta, cx + 32, cy + 178, cardW - 64, 40, {
            fontSize: 22,
            fill: theme.secondary,
            delay: 8 + idx * 3,
          });
        }
      });
      break;
    }

    case 'quote': {
      const quoteText = slide.quote ?? slide.bullets[0] ?? slide.title;
      pushRect(
        'quote-card',
        'Quote Card',
        padX,
        Math.round(height * 0.22),
        contentW,
        Math.round(height * 0.54),
        theme.surface,
        28,
        2,
      );
      pushText(
        'quote-mark',
        'Quote Mark',
        '“',
        padX + 48,
        Math.round(height * 0.24),
        120,
        120,
        { fontSize: 110, fontWeight: 700, fill: theme.accent, delay: 3 },
      );
      pushText(
        'quote-body',
        'Quote Body',
        quoteText,
        padX + 96,
        Math.round(height * 0.34),
        contentW - 192,
        180,
        { fontSize: 44, fontWeight: 600, fill: theme.primary, delay: 5 },
      );
      if (slide.attribution || slide.subtitle) {
        pushText(
          'attribution',
          'Attribution',
          `— ${slide.attribution ?? slide.subtitle}`,
          padX + 96,
          Math.round(height * 0.62),
          contentW - 192,
          52,
          { fontSize: 28, fill: theme.secondary, delay: 8 },
        );
      }
      break;
    }

    case 'code-walkthrough': {
      pushText('title', 'Title', slide.title, padX, padY + 34, contentW, 84, {
        fontSize: 48,
        fontWeight: 700,
        fontFamily: theme.fontTitle,
        delay: 2,
      });
      const topY = padY + 136;
      const codeBoxX = slide.bullets.length > 0 ? padX + Math.floor(contentW * 0.38) : padX;
      const codeBoxW = slide.bullets.length > 0 ? Math.floor(contentW * 0.62) : contentW;
      const codeBoxH = height - topY - padY - 36;
      if (slide.bullets.length > 0) {
        slide.bullets.slice(0, 6).forEach((b, idx) => {
          pushText(
            `bullet-${idx}`,
            `Bullet ${idx + 1}`,
            `• ${b}`,
            padX,
            topY + 16 + idx * 84,
            Math.floor(contentW * 0.35),
            74,
            { fontSize: 26, fill: theme.primary, delay: 4 + idx * 3 },
          );
        });
      }
      pushRect('code-box', 'Code Surface', codeBoxX, topY, codeBoxW, codeBoxH, '#090d16', 18, 4);
      const codeText = slide.code ?? slide.bullets.join('\n');
      pushText(
        'code-text',
        'Code Content',
        codeText,
        codeBoxX + 32,
        topY + 32,
        codeBoxW - 64,
        codeBoxH - 64,
        {
          fontSize: 24,
          fontFamily: theme.fontMono,
          fill: '#e2e8f0',
          whiteSpace: 'pre-wrap',
          delay: 6,
        },
      );
      break;
    }

    case 'comparison-table': {
      pushText('title', 'Title', slide.title, padX, padY + 34, contentW, 84, {
        fontSize: 48,
        fontWeight: 700,
        fontFamily: theme.fontTitle,
        delay: 2,
      });
      const table: SlideTable = slide.table ?? {
        headers: ['Item', 'Specification'],
        rows: slide.bullets.map((b, idx) => {
          const parts = b.split(/[:：|]/).map((s) => s.trim());
          return parts.length >= 2 ? [parts[0], parts.slice(1).join(' ')] : [`Row ${idx + 1}`, b];
        }),
      };
      const cols = Math.max(1, table.headers.length);
      const totalRows = 1 + table.rows.length;
      const tableTop = padY + 140;
      const tableH = height - tableTop - padY - 40;
      const rowH = Math.min(88, Math.floor(tableH / Math.max(1, totalRows)));
      const colW = Math.floor(contentW / cols);

      pushRect('table-header-bg', 'Table Header', padX, tableTop, contentW, rowH, theme.accentSoft, 12, 4);
      table.headers.forEach((h, cIdx) => {
        pushText(
          `table-th-${cIdx}`,
          `Header ${cIdx + 1}`,
          h,
          padX + cIdx * colW + 20,
          tableTop + Math.max(12, Math.floor((rowH - 36) / 2)),
          colW - 40,
          40,
          { fontSize: 26, fontWeight: 700, fill: theme.accent, delay: 5 },
        );
      });
      table.rows.forEach((row, rIdx) => {
        const ry = tableTop + (rIdx + 1) * rowH;
        if (rIdx % 2 === 1) {
          pushRect(`table-row-bg-${rIdx}`, `Row ${rIdx + 1} Background`, padX, ry, contentW, rowH, theme.surface, 8, 6 + rIdx * 2);
        }
        row.slice(0, cols).forEach((cell, cIdx) => {
          pushText(
            `table-td-${rIdx}-${cIdx}`,
            `Cell R${rIdx + 1}C${cIdx + 1}`,
            cell,
            padX + cIdx * colW + 20,
            ry + Math.max(12, Math.floor((rowH - 34) / 2)),
            colW - 40,
            38,
            { fontSize: 24, fill: theme.primary, delay: 6 + rIdx * 2 },
          );
        });
      });
      break;
    }

    case 'closing': {
      const centerY = Math.round(height * 0.36);
      pushRect(
        'closing-card',
        'Closing Card',
        padX,
        Math.round(height * 0.22),
        contentW,
        Math.round(height * 0.54),
        theme.surface,
        28,
        2,
      );
      pushText('title', 'Closing Title', slide.title, padX + 64, centerY, contentW - 128, 110, {
        fontSize: 68,
        fontWeight: 700,
        align: 'center',
        fontFamily: theme.fontTitle,
        delay: 4,
      });
      if (slide.subtitle || slide.bullets[0]) {
        pushText(
          'subtitle',
          'Closing Subtitle',
          slide.subtitle ?? slide.bullets.join('   ·   '),
          padX + 64,
          centerY + 124,
          contentW - 128,
          64,
          { fontSize: 32, fill: theme.accent, align: 'center', delay: 7 },
        );
      }
      break;
    }

    case 'bullet-points':
    default: {
      pushText('title', 'Title', slide.title, padX, padY + 34, contentW, 84, {
        fontSize: 52,
        fontWeight: 700,
        fontFamily: theme.fontTitle,
        delay: 2,
      });
      let listTop = padY + 132;
      if (slide.subtitle) {
        pushText('subtitle', 'Subtitle', slide.subtitle, padX, listTop, contentW, 56, {
          fontSize: 28,
          fill: theme.secondary,
          delay: 4,
        });
        listTop += 72;
      }
      const bullets = slide.bullets;
      const stepY = bullets.length > 6 ? 76 : 92;
      bullets.slice(0, 10).forEach((b, idx) => {
        const leadingSpaces = b.match(/^\s+/)?.[0].length ?? 0;
        const indentLevel = Math.min(3, Math.floor(leadingSpaces / 2));
        const cleanText = b.trim();
        const bx = padX + indentLevel * 44;
        const by = listTop + idx * stepY;
        pushRect(
          `bullet-dot-${idx}`,
          `Bullet Dot ${idx + 1}`,
          bx,
          by + 14,
          12,
          12,
          theme.accent,
          6,
          5 + idx * 3,
        );
        pushText(
          `bullet-${idx}`,
          `Bullet ${idx + 1}`,
          cleanText,
          bx + 28,
          by,
          contentW - indentLevel * 44 - 28,
          stepY - 8,
          {
            fontSize: indentLevel > 0 ? 28 : 32,
            fill: indentLevel > 0 ? theme.secondary : theme.primary,
            delay: 5 + idx * 3,
          },
        );
      });
      break;
    }
  }

  // Footer & slide number
  const footerY = height - Math.round(padY * 0.65);
  if (slide.footer) {
    pushText('footer', 'Footer', slide.footer, padX, footerY, Math.floor(contentW * 0.7), 32, {
      fontSize: 20,
      fill: theme.secondary,
      delay: 0,
    });
  }
  pushText(
    'page-number',
    'Slide Number',
    `${index + 1} / ${total}`,
    padX + Math.floor(contentW * 0.75),
    footerY,
    Math.floor(contentW * 0.25),
    32,
    {
      fontSize: 20,
      fill: theme.secondary,
      align: 'right',
      delay: 0,
    },
  );

  return sceneSchema.parse({
    id: sceneId,
    name: `${String(index + 1).padStart(2, '0')} · ${slide.title.slice(0, 60)}`,
    duration: slide.durationFrames,
    background: theme.background,
    nodes,
  });
}

/**
 * Synchronize live node edits from a `Scene` back into a `SlideSpec` (so direct canvas text edits round-trip into `.pptx` and `slides_inspect`).
 */
export function syncSlideFromScene(slide: SlideSpec, scene: Scene | undefined): SlideSpec {
  if (!scene) return slide;
  const updated: SlideSpec = structuredClone(slide);
  updated.durationFrames = scene.duration;
  const sceneId = slide.sceneId ?? slide.id;
  const findText = (suffix: string) =>
    scene.nodes.find((n) => n.id === `${sceneId}/${suffix}` && n.type === 'text')?.text;
  const sortByIdNumeric = <T extends { id: string }>(arr: T[]) =>
    [...arr].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const titleText = findText('title');
  if (titleText) updated.title = titleText;

  const subtitleText = findText('subtitle');
  if (subtitleText !== undefined) {
    const closingFallback = slide.layout === 'closing' ? slide.bullets.join('   ·   ') : undefined;
    if (slide.subtitle !== undefined || subtitleText !== closingFallback) {
      updated.subtitle = subtitleText;
    }
  }

  const badgeText = findText('badge');
  if (badgeText !== undefined && badgeText !== (slide.badge ?? '').toUpperCase()) {
    updated.badge = badgeText;
  }

  const footerText = findText('footer');
  if (footerText !== undefined) updated.footer = footerText;

  const quoteBody = findText('quote-body');
  if (quoteBody !== undefined) {
    const quoteFallback = slide.bullets[0] ?? slide.title;
    if (slide.quote !== undefined || quoteBody !== quoteFallback) {
      updated.quote = quoteBody;
    }
  }

  const attrText = findText('attribution');
  if (attrText !== undefined) {
    const cleanAttr = attrText.replace(/^[—–-]\s*/, '');
    if (slide.attribution !== undefined || cleanAttr !== (slide.subtitle ?? '')) {
      updated.attribution = cleanAttr;
    }
  }

  const codeText = findText('code-text');
  if (codeText !== undefined) {
    if (slide.code !== undefined || codeText !== slide.bullets.join('\n')) {
      updated.code = codeText;
    }
  }

  // Standard bullets (preserving nested indent levels on bullet-points via bullet-dot X offset)
  const accentBar = scene.nodes.find((n) => n.id === `${sceneId}/accent-bar`);
  const bulletNodes = sortByIdNumeric(
    scene.nodes.filter(
      (n: Node) =>
        n.type === 'text' && new RegExp(`^${escapeRegExp(sceneId)}/bullet-\\d+$`).test(n.id),
    ),
  );
  if (bulletNodes.length > 0) {
    updated.bullets = bulletNodes.map((n) => {
      const idxStr = n.id.slice(n.id.lastIndexOf('-') + 1);
      const dotNode = scene.nodes.find((d) => d.id === `${sceneId}/bullet-dot-${idxStr}`);
      const indentLevel =
        dotNode && accentBar
          ? Math.max(0, Math.min(3, Math.round((dotNode.x - accentBar.x) / 44)))
          : 0;
      const clean = n.text.replace(/^[•·-]\s*/, '').trim();
      return `${'  '.repeat(indentLevel)}${clean}`;
    });
  }

  // Two-column slots
  const leftHeading = findText('left-heading');
  const leftBullets = sortByIdNumeric(
    scene.nodes.filter(
      (n: Node) =>
        n.type === 'text' && new RegExp(`^${escapeRegExp(sceneId)}/left-bullet-\\d+$`).test(n.id),
    ),
  );
  if (slide.layout === 'two-column' && (leftHeading !== undefined || leftBullets.length > 0)) {
    updated.left = {
      ...(updated.left ?? { bullets: [] }),
      ...(leftHeading !== undefined ? { heading: leftHeading } : {}),
      ...(leftBullets.length > 0
        ? { bullets: leftBullets.map((n) => n.text.replace(/^[•·-]\s*/, '')) }
        : {}),
    };
  }
  const rightHeading = findText('right-heading');
  const rightBullets = sortByIdNumeric(
    scene.nodes.filter(
      (n: Node) =>
        n.type === 'text' && new RegExp(`^${escapeRegExp(sceneId)}/right-bullet-\\d+$`).test(n.id),
    ),
  );
  if (slide.layout === 'two-column' && (rightHeading !== undefined || rightBullets.length > 0)) {
    updated.right = {
      ...(updated.right ?? { bullets: [] }),
      ...(rightHeading !== undefined ? { heading: rightHeading } : {}),
      ...(rightBullets.length > 0
        ? { bullets: rightBullets.map((n) => n.text.replace(/^[•·-]\s*/, '')) }
        : {}),
    };
  }

  // Metrics-grid slots
  const metricValueNodes = sortByIdNumeric(
    scene.nodes.filter(
      (n: Node) =>
        n.type === 'text' && new RegExp(`^${escapeRegExp(sceneId)}/metric-value-\\d+$`).test(n.id),
    ),
  );
  if (slide.layout === 'metrics-grid' && metricValueNodes.length > 0) {
    updated.metrics = metricValueNodes.map((valNode, idx) => {
      const idxStr = valNode.id.slice(valNode.id.lastIndexOf('-') + 1);
      const label = findText(`metric-label-${idxStr}`) ?? updated.metrics[idx]?.label ?? `Metric ${idx + 1}`;
      const delta = findText(`metric-delta-${idxStr}`) ?? updated.metrics[idx]?.delta;
      return {
        label,
        value: valNode.text,
        ...(delta !== undefined ? { delta } : {}),
      };
    });
  }

  // Comparison-table slots
  const tableHeaderNodes = sortByIdNumeric(
    scene.nodes.filter(
      (n: Node) =>
        n.type === 'text' && new RegExp(`^${escapeRegExp(sceneId)}/table-th-\\d+$`).test(n.id),
    ),
  );
  const tableCellNodes = scene.nodes.filter(
    (n: Node) =>
      n.type === 'text' && new RegExp(`^${escapeRegExp(sceneId)}/table-td-\\d+-\\d+$`).test(n.id),
  );
  if (slide.layout === 'comparison-table' && (tableHeaderNodes.length > 0 || tableCellNodes.length > 0)) {
    const headers =
      tableHeaderNodes.length > 0
        ? tableHeaderNodes.map((n) => n.text)
        : (updated.table?.headers ?? ['Item', 'Specification']);
    const rowMap = new Map<number, Map<number, string>>();
    for (const cell of tableCellNodes) {
      const m = cell.id.match(/\/table-td-(\d+)-(\d+)$/);
      if (!m) continue;
      const r = Number.parseInt(m[1], 10);
      const c = Number.parseInt(m[2], 10);
      if (!rowMap.has(r)) rowMap.set(r, new Map());
      rowMap.get(r)!.set(c, cell.text);
    }
    const rowIndices = [...rowMap.keys()].sort((a, b) => a - b);
    const rows =
      rowIndices.length > 0
        ? rowIndices.map((rIdx) => {
            const colsMap = rowMap.get(rIdx)!;
            return headers.map((_, cIdx) => colsMap.get(cIdx) ?? updated.table?.rows[rIdx]?.[cIdx] ?? '');
          })
        : (updated.table?.rows ?? []);
    if (rows.length > 0) {
      updated.table = { headers, rows };
    }
  }

  return updated;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSlideXml(
  slide: SlideSpec,
  theme: SlideTheme,
  widthEmu: number,
  heightEmu: number,
  imageRelId?: string,
): string {
  const padX = Math.round(widthEmu * 0.065);
  const padY = Math.round(heightEmu * 0.08);
  const contentW = widthEmu - padX * 2;
  const hasSplitImage = Boolean(imageRelId);
  const textContentW =
    hasSplitImage && slide.layout === 'image-split' ? Math.floor(contentW * 0.52) : contentW;
  const bgHex = theme.background.replace('#', '').slice(0, 6).padEnd(6, '0').toUpperCase();
  const primaryHex = theme.primary.replace('#', '').slice(0, 6).padEnd(6, '0').toUpperCase();
  const secondaryHex = theme.secondary.replace('#', '').slice(0, 6).padEnd(6, '0').toUpperCase();
  const accentHex = theme.accent.replace('#', '').slice(0, 6).padEnd(6, '0').toUpperCase();

  let shapeId = 2;
  const shapes: string[] = [];

  const addTextShape = (
    name: string,
    phType: string | null,
    x: number,
    y: number,
    cx: number,
    cy: number,
    paragraphs: Array<{ text: string; sizePt: number; colorHex: string; bold?: boolean; level?: number }>,
  ) => {
    const id = shapeId++;
    const phXml = phType ? `<p:ph type="${phType}"/>` : '';
    const paraXml = paragraphs
      .map((p) => {
        const sz = Math.round(p.sizePt * 100);
        const bAttr = p.bold ? ' b="1"' : '';
        const lvlAttr = p.level ? ` lvl="${p.level}"` : '';
        return `<a:p><a:pPr${lvlAttr}/><a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${sz}"${bAttr} dirty="0"><a:solidFill><a:srgbClr val="${p.colorHex}"/></a:solidFill><a:latin typeface="${xmlEscape(theme.fontBody)}"/><a:ea typeface="${xmlEscape(theme.fontBody)}"/></a:rPr><a:t>${xmlEscape(p.text)}</a:t></a:r></a:p>`;
      })
      .join('');
    shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr>${phXml}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paraXml}</p:txBody></p:sp>`,
    );
  };

  if (slide.badge) {
    addTextShape('vmotion-badge', null, padX, padY - 120000, Math.round(textContentW * 0.5), 360000, [
      { text: slide.badge, sizePt: 14, colorHex: accentHex, bold: true },
    ]);
  }

  addTextShape(
    'vmotion-title',
    slide.layout === 'title-cover' ? 'ctrTitle' : 'title',
    padX,
    slide.layout === 'title-cover' ? Math.round(heightEmu * 0.34) : padY + 240000,
    textContentW,
    920000,
    [{ text: slide.title, sizePt: slide.layout === 'title-cover' ? 44 : 34, colorHex: primaryHex, bold: true }],
  );

  if (slide.subtitle) {
    addTextShape(
      'vmotion-subtitle',
      'subTitle',
      padX,
      slide.layout === 'title-cover' ? Math.round(heightEmu * 0.52) : padY + 1150000,
      textContentW,
      620000,
      [{ text: slide.subtitle, sizePt: 20, colorHex: secondaryHex }],
    );
  }

  if (slide.layout === 'two-column' && (slide.left || slide.right)) {
    const colW = Math.floor((contentW - 360000) / 2);
    const colY = padY + 1500000;
    const colH = heightEmu - colY - padY;
    const leftLines = [
      ...(slide.left?.heading ? [slide.left.heading] : []),
      ...(slide.left?.bullets ?? []),
    ];
    const rightLines = [
      ...(slide.right?.heading ? [slide.right.heading] : []),
      ...(slide.right?.bullets ?? []),
    ];
    if (leftLines.length > 0) {
      addTextShape(
        'vmotion-col-left',
        'body',
        padX,
        colY,
        colW,
        colH,
        leftLines.map((t, idx) => ({
          text: t,
          sizePt: idx === 0 && slide.left?.heading ? 22 : 18,
          colorHex: idx === 0 && slide.left?.heading ? accentHex : primaryHex,
          bold: idx === 0 && Boolean(slide.left?.heading),
        })),
      );
    }
    if (rightLines.length > 0) {
      addTextShape(
        'vmotion-col-right',
        'body',
        padX + colW + 360000,
        colY,
        colW,
        colH,
        rightLines.map((t, idx) => ({
          text: t,
          sizePt: idx === 0 && slide.right?.heading ? 22 : 18,
          colorHex: idx === 0 && slide.right?.heading ? accentHex : primaryHex,
          bold: idx === 0 && Boolean(slide.right?.heading),
        })),
      );
    }
  } else if (slide.layout === 'comparison-table' && slide.table) {
    const cols = slide.table.headers.length;
    const colW = Math.floor(contentW / Math.max(1, cols));
    const gridColXml = slide.table.headers.map(() => `<a:gridCol w="${colW}"/>`).join('');
    const allRows = [slide.table.headers, ...slide.table.rows];
    const rowH = 520000;
    const rowsXml = allRows
      .map((row, rIdx) => {
        const cellsXml = row
          .slice(0, cols)
          .map(
            (cell) =>
              `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="${rIdx === 0 ? 1800 : 1600}"${rIdx === 0 ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${rIdx === 0 ? accentHex : primaryHex}"/></a:solidFill></a:rPr><a:t>${xmlEscape(cell)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`,
          )
          .join('');
        return `<a:tr h="${rowH}">${cellsXml}</a:tr>`;
      })
      .join('');
    const id = shapeId++;
    shapes.push(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="vmotion-table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${padX}" y="${padY + 1450000}"/><a:ext cx="${contentW}" cy="${allRows.length * rowH}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${gridColXml}</a:tblGrid>${rowsXml}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    );
  } else {
    const bodyLines: string[] =
      slide.layout === 'quote' && slide.quote
        ? [slide.quote, ...(slide.attribution ? [slide.attribution] : [])]
        : slide.layout === 'code-walkthrough' && slide.code
          ? slide.code.split('\n')
          : slide.layout === 'metrics-grid' && slide.metrics.length > 0
            ? slide.metrics.map((m) => `${m.label} | ${m.value}${m.delta ? ` | ${m.delta}` : ''}`)
            : slide.bullets;
    if (bodyLines.length > 0) {
      addTextShape(
        'vmotion-body',
        'body',
        padX,
        padY + (slide.subtitle ? 1850000 : 1350000),
        textContentW,
        heightEmu - padY * 2 - 1500000,
        bodyLines.map((line) => {
          const leading = line.match(/^\s+/)?.[0].length ?? 0;
          const level = Math.min(3, Math.floor(leading / 2));
          return {
            text: line.trim(),
            sizePt: slide.layout === 'code-walkthrough' ? 15 : 20,
            colorHex: primaryHex,
            level,
          };
        }),
      );
    }
  }

  if (imageRelId) {
    const picId = shapeId++;
    const gapEmu = Math.round(widthEmu * 0.03);
    const picX =
      slide.layout === 'image-split'
        ? padX + textContentW + gapEmu
        : padX + Math.floor(contentW * 0.55);
    const picW =
      slide.layout === 'image-split'
        ? contentW - textContentW - gapEmu
        : Math.floor(contentW * 0.45);
    const picY = padY + 240000;
    const picH = heightEmu - padY * 2 - 480000;
    shapes.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${picId}" name="vmotion-image"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${imageRelId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(picX)}" y="${Math.round(picY)}"/><a:ext cx="${Math.round(picW)}" cy="${Math.round(picH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
    );
  }

  if (slide.footer) {
    addTextShape('vmotion-footer', 'ftr', padX, heightEmu - Math.round(padY * 0.7), contentW, 320000, [
      { text: slide.footer, sizePt: 12, colorHex: secondaryHex },
    ]);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${shapes.join('\n      ')}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function buildNotesXml(slide: SlideSpec): string {
  const noteLines = [
    `[vmotion:layout=${slide.layout}]`,
    ...slide.notes
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  ];
  const paras = noteLines
    .map(
      (line) =>
        `<a:p><a:r><a:rPr lang="zh-CN" altLang="en-US" sz="1200"/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`;
}

export interface PptxMediaExportEntry {
  data: Uint8Array;
  mimeType?: string;
  ext?: string;
}

/**
 * Build a deterministic, standards-compliant OpenXML `.pptx` buffer from a `SlideDeckDocument`.
 */
export function buildPptxBuffer(
  deck: SlideDeckDocument,
  options: {
    widthPx?: number;
    heightPx?: number;
    snapshot?: Snapshot;
    media?: Record<string, PptxMediaExportEntry>;
  } = {},
): Uint8Array {
  const widthPx = options.widthPx ?? options.snapshot?.project.width ?? 1920;
  const heightPx = options.heightPx ?? options.snapshot?.project.height ?? 1080;
  const cxEmu = Math.round(widthPx * EMU_PER_PIXEL);
  const cyEmu = Math.round(heightPx * EMU_PER_PIXEL);

  const syncedSlides = deck.slides.map((slide) => {
    const scene = options.snapshot?.scenes.find((s) => s.id === (slide.sceneId ?? slide.id));
    return syncSlideFromScene(slide, scene);
  });

  const archive: Zippable = {};
  const putXml = (path: string, content: string) => {
    archive[path] = [strToU8(content), { mtime: FIXED_ZIP_MTIME, level: 6 }];
  };

  const slideContentTypeOverrides = syncedSlides
    .map(
      (_, idx) =>
        `  <Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\n  <Override PartName="/ppt/notesSlides/notesSlide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
    )
    .join('\n');

  putXml(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="webp" ContentType="image/webp"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${slideContentTypeOverrides}
</Types>`,
  );

  putXml(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );

  putXml(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(deck.name)}</dc:title>
  <dc:creator>Vmotion Studio</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created>
</cp:coreProperties>`,
  );

  putXml(
    'docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Vmotion Programmable Video Workstation</Application>
  <Slides>${syncedSlides.length}</Slides>
</Properties>`,
  );

  const presRelsXml = syncedSlides
    .map(
      (_, idx) =>
        `  <Relationship Id="rIdSlide${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx + 1}.xml"/>`,
    )
    .join('\n');

  putXml(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
${presRelsXml}
</Relationships>`,
  );

  const sldIdLstXml = syncedSlides
    .map((_, idx) => `    <p:sldId id="${256 + idx}" r:id="rIdSlide${idx + 1}"/>`)
    .join('\n');

  putXml(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rIdMaster1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
${sldIdLstXml}
  </p:sldIdLst>
  <p:sldSz cx="${cxEmu}" cy="${cyEmu}" type="custom"/>
  <p:notesSz cx="${cyEmu}" cy="${cxEmu}"/>
</p:presentation>`,
  );

  putXml(
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
  );

  putXml(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
  );

  putXml(
    'ppt/slideLayouts/slideLayout1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sldLayout>`,
  );

  putXml(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
  );

  putXml(
    'ppt/theme/theme1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Vmotion Theme">
  <a:themeElements>
    <a:clrScheme name="Vmotion">
      <a:dk1><a:srgbClr val="0D1322"/></a:dk1>
      <a:lt1><a:srgbClr val="F8FAFC"/></a:lt1>
      <a:dk2><a:srgbClr val="162038"/></a:dk2>
      <a:lt2><a:srgbClr val="94A3B8"/></a:lt2>
      <a:accent1><a:srgbClr val="38BDF8"/></a:accent1>
      <a:accent2><a:srgbClr val="10B981"/></a:accent2>
      <a:accent3><a:srgbClr val="F59E0B"/></a:accent3>
      <a:accent4><a:srgbClr val="EC4899"/></a:accent4>
      <a:accent5><a:srgbClr val="8B5CF6"/></a:accent5>
      <a:accent6><a:srgbClr val="06B6D4"/></a:accent6>
      <a:hlink><a:srgbClr val="38BDF8"/></a:hlink>
      <a:folHlink><a:srgbClr val="94A3B8"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="VmotionFonts">
      <a:majorFont><a:latin typeface="${xmlEscape(deck.theme.fontTitle)}"/><a:ea typeface="${xmlEscape(deck.theme.fontTitle)}"/><a:cs typeface="${xmlEscape(deck.theme.fontTitle)}"/></a:majorFont>
      <a:minorFont><a:latin typeface="${xmlEscape(deck.theme.fontBody)}"/><a:ea typeface="${xmlEscape(deck.theme.fontBody)}"/><a:cs typeface="${xmlEscape(deck.theme.fontBody)}"/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="VmotionFmt"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>
  </a:themeElements>
</a:theme>`,
  );

  syncedSlides.forEach((slide, idx) => {
    const n = idx + 1;
    const slideNo = String(n).padStart(2, '0');
    const mediaEntry = slide.mediaAssetId ? options.media?.[slide.mediaAssetId] : undefined;
    let imageRelXml = '';
    let imageRelId: string | undefined;

    if (mediaEntry && mediaEntry.data.byteLength > 0) {
      const rawExt = (mediaEntry.ext ?? '').toLowerCase().replace(/^\./, '');
      const ext = ['png', 'jpg', 'jpeg', 'webp'].includes(rawExt)
        ? rawExt
        : mediaEntry.mimeType === 'image/jpeg'
          ? 'jpg'
          : mediaEntry.mimeType === 'image/webp'
            ? 'webp'
            : 'png';
      const mediaFilename = `slide-${slideNo}.${ext}`;
      archive[`ppt/media/${mediaFilename}`] = [
        mediaEntry.data,
        { mtime: FIXED_ZIP_MTIME, level: 6 },
      ];
      imageRelId = 'rIdImage1';
      imageRelXml = `\n  <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaFilename}"/>`;
    }

    putXml(`ppt/slides/slide${n}.xml`, buildSlideXml(slide, deck.theme, cxEmu, cyEmu, imageRelId));
    putXml(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rIdNotes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>${imageRelXml}
</Relationships>`,
    );
    putXml(`ppt/notesSlides/notesSlide${n}.xml`, buildNotesXml(slide));
    putXml(
      `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdSlide1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${n}.xml"/>
</Relationships>`,
    );
  });

  return zipSync(archive);
}
