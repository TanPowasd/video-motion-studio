import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SLIDE_LAYOUT_IDS,
  SLIDE_THEME_PRESETS,
  buildPptxBuffer,
  parsePptxBuffer,
  type SlideDeckDocument,
} from '../src/core/slides.js';
import { Application } from '../src/service/application.js';
import { importSlides, inspectSlides, planSlides } from '../src/service/slides.js';

describe('Presentation Slides (.pptx import/export, 10 layouts, and AI batch planning)', () => {
  let root = '';
  let app: Application;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vmotion-slides-'));
    await mkdir(path.join(root, 'scenes'), { recursive: true });
    await mkdir(path.join(root, 'sequences'), { recursive: true });
    await writeFile(
      path.join(root, 'project.vmotion.json'),
      JSON.stringify(
        {
          formatVersion: 1,
          id: 'slides-test-project',
          name: 'Slides Demo',
          width: 1920,
          height: 1080,
          fps: { num: 30, den: 1 },
          activeSequence: 'main',
          scenes: ['scenes/intro.json'],
          sequences: ['sequences/main.json'],
          assets: [],
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, 'scenes/intro.json'),
      JSON.stringify(
        {
          id: 'intro',
          name: 'Intro',
          duration: 90,
          background: '#0d1322',
          nodes: [],
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, 'sequences/main.json'),
      JSON.stringify(
        {
          id: 'main',
          name: 'Main Sequence',
          duration: 90,
          tracks: [
            { id: 'video-1', name: 'Video 1', type: 'video', muted: false, clips: [] },
            { id: 'audio-1', name: 'Audio 1', type: 'audio', muted: false, clips: [] },
          ],
          markers: [],
        },
        null,
        2,
      ),
    );
    app = await new Application(root).open(true);
  });

  afterAll(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('builds and parses deterministic .pptx archives across layouts, tables, and speaker notes', () => {
    const sampleDeck: SlideDeckDocument = {
      id: 'keynote',
      name: 'Vmotion Q4 Keynote',
      sequenceId: 'main',
      videoTrackId: 'video-1',
      theme: SLIDE_THEME_PRESETS['editorial-dark'],
      slides: [
        {
          id: 'slide-01',
          layout: 'title-cover',
          badge: 'Product Launch',
          title: 'Vmotion Programmable Video Studio',
          subtitle: 'Code-Driven Motion Graphics & Presentation Pipeline',
          bullets: [],
          metrics: [],
          footer: 'Vmotion Team · 2026',
          notes: 'Welcome everyone to the Q4 keynote presentation.',
          durationFrames: 120,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
        {
          id: 'slide-02',
          layout: 'two-column',
          title: 'Architecture Comparison',
          bullets: [],
          left: {
            heading: 'Declarative Scene Graph',
            bullets: ['Deterministic frame seeking', 'Shared candidate preflight'],
          },
          right: {
            heading: 'Plugin Ecosystem',
            bullets: ['18 built-in modules', 'External .vmplugin workers'],
          },
          metrics: [],
          notes: 'Compare the scene graph and plugin architecture.',
          durationFrames: 150,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
        {
          id: 'slide-03',
          layout: 'comparison-table',
          title: 'Performance Benchmarks',
          bullets: [],
          metrics: [],
          table: {
            headers: ['Pipeline', 'Frame Time', 'Determinism'],
            rows: [
              ['CPU Skia', '6.2 ms', '100% Exact'],
              ['GPU Effects', '1.8 ms', '100% Exact'],
            ],
          },
          notes: 'Walk through the benchmark numbers.',
          durationFrames: 150,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
      ],
    };

    const pptxA = buildPptxBuffer(sampleDeck, { widthPx: 1920, heightPx: 1080 });
    const pptxB = buildPptxBuffer(sampleDeck, { widthPx: 1920, heightPx: 1080 });
    // Deterministic ZIP archive output
    expect(Buffer.compare(Buffer.from(pptxA), Buffer.from(pptxB))).toBe(0);

    const parsed = parsePptxBuffer(pptxA);
    expect(parsed.widthPx).toBe(1920);
    expect(parsed.heightPx).toBe(1080);
    expect(parsed.slides).toHaveLength(3);
    expect(parsed.slides[0]).toMatchObject({
      layout: 'title-cover',
      badge: 'Product Launch',
      title: 'Vmotion Programmable Video Studio',
      subtitle: 'Code-Driven Motion Graphics & Presentation Pipeline',
      footer: 'Vmotion Team · 2026',
      notes: 'Welcome everyone to the Q4 keynote presentation.',
    });
    expect(parsed.slides[1]).toMatchObject({
      layout: 'two-column',
      title: 'Architecture Comparison',
    });
    expect(parsed.slides[1].left?.heading).toBe('Declarative Scene Graph');
    expect(parsed.slides[1].right?.heading).toBe('Plugin Ecosystem');
    expect(parsed.slides[2]).toMatchObject({
      layout: 'comparison-table',
      title: 'Performance Benchmarks',
      table: {
        headers: ['Pipeline', 'Frame Time', 'Determinism'],
        rows: [
          ['CPU Skia', '6.2 ms', '100% Exact'],
          ['GPU Effects', '1.8 ms', '100% Exact'],
        ],
      },
    });
  });

  it('imports a .pptx file into a candidate plan, applies it atomically, and supports all 10 layouts', async () => {
    const allLayoutsDeck: SlideDeckDocument = {
      id: 'all-layouts',
      name: 'Ten Layouts Showcase',
      sequenceId: app.service.snapshot.project.activeSequence,
      videoTrackId: app.service.snapshot.sequences[0].tracks.find((t) => t.type === 'video')!.id,
      theme: SLIDE_THEME_PRESETS['emerald-tech'],
      slides: SLIDE_LAYOUT_IDS.map((layout, idx) => ({
        id: `slide-${String(idx + 1).padStart(2, '0')}`,
        layout,
        title: `Slide ${idx + 1}: ${layout}`,
        subtitle: `Subtitle for ${layout}`,
        bullets: [
          `First key takeaway for ${layout}`,
          `Second key takeaway for ${layout}`,
          `Third key takeaway for ${layout}`,
        ],
        metrics:
          layout === 'metrics-grid'
            ? [
                { label: 'Throughput', value: '120 fps', delta: '+45%' },
                { label: 'Context Size', value: '2.9 KB', delta: '-68%' },
              ]
            : [],
        code:
          layout === 'code-walkthrough'
            ? 'const frame = useFrame();\nreturn <Slide layout="code-walkthrough" />;'
            : undefined,
        quote: layout === 'quote' ? 'Programmable video should be deterministic and inspectable.' : undefined,
        attribution: layout === 'quote' ? 'Vmotion Architecture Guide' : undefined,
        table:
          layout === 'comparison-table'
            ? {
                headers: ['Metric', 'Before', 'After'],
                rows: [['Startup', '4.6s', '2.0s']],
              }
            : undefined,
        notes: `Speaker notes for slide ${idx + 1} (${layout}).`,
        durationFrames: 90,
        animateEntrance: true,
        transition: { type: 'fade', durationFrames: 10 },
      })),
    };

    const pptxBytes = buildPptxBuffer(allLayoutsDeck);
    const pptxPath = path.join(root, 'input-showcase.pptx');
    await writeFile(pptxPath, pptxBytes);

    const imported = (await app.dispatch('slidesImport', {
      file: 'input-showcase.pptx',
      id: 'showcase',
      theme: 'emerald-tech',
    })) as any;
    expect(imported.deckId).toBe('showcase');
    expect(imported.slideCount).toBe(10);
    expect(imported.candidate.planId).toMatch(/^[a-f0-9]{64}$/);

    const preflight = (await app.dispatch('projectPreflight', imported.candidate)) as any;
    expect(preflight.valid).toBe(true);

    const beforeApplyRev = app.service.snapshot.revision;
    const applied = (await app.dispatch('projectApply', imported.apply)) as any;
    expect(applied.revision).toBe(imported.candidateRevision);
    expect(applied.revision).not.toBe(beforeApplyRev);

    // Inspect the applied deck
    const inspected = (await app.dispatch('slidesInspect', {
      source: 'components/slides/showcase.json',
      limit: 20,
    })) as any;
    expect(inspected.summary.totalSlides).toBe(10);
    expect(inspected.summary.slidesWithNotes).toBe(10);
    expect(inspected.slides.items[0].layout).toBe('title-cover');
    expect(inspected.slides.items[0].placement).toMatchObject({
      clipId: 'slides/showcase/slide-01',
      start: 0,
    });
  });

  it('supports AI batch slide edits (updateSlide, splitSlide, reorder, autoTiming, exportPptx) and single-step undo', async () => {
    // Also verify that direct canvas text edits on a slide scene sync back into slidesInspect and slidesPlan!
    await app.dispatch('projectApply', {
      revision: app.service.snapshot.revision,
      operations: [
        {
          type: 'updateNode',
          sceneId: 'showcase-slide-01',
          nodeId: 'showcase-slide-01/title',
          patch: { text: 'Canvas Edited Cover Title' },
        },
      ],
    });

    const afterCanvasEdit = inspectSlides(app.service.snapshot, {
      source: 'components/slides/showcase.json',
    });
    expect(afterCanvasEdit.slides.items[0].title).toBe('Canvas Edited Cover Title');

    const beforePlanRev = app.service.snapshot.revision;
    const planned = (await app.dispatch('slidesPlan', {
      source: 'components/slides/showcase.json',
      actions: [
        {
          type: 'updateSlide',
          slideId: 'slide-03',
          patch: {
            title: 'AI Refined Bullet Slide',
            bullets: [
              'Point 1: Automated PPTX import',
              'Point 2: Ten semantic slide layouts',
              'Point 3: Fast AI batch modification',
              'Point 4: Single-step shared undo',
              'Point 5: Overflow auto-splitting',
              'Point 6: Deterministic PPTX round-trip export',
            ],
          },
        },
        {
          type: 'splitSlide',
          slideId: 'slide-03',
          maxBulletsPerSlide: 3,
        },
        {
          type: 'applyTheme',
          preset: 'sunset-keynote',
        },
        {
          type: 'autoTiming',
          minDurationFrames: 75,
          maxDurationFrames: 300,
          slideIds: ['slide-01', 'slide-03'],
        },
      ],
      exportPptx: {
        path: 'exports/slides/refined-showcase.pptx',
      },
      detail: true,
    })) as any;

    // 10 slides + 1 from splitSlide = 11 slides
    expect(planned.slideCount).toBe(11);
    expect(planned.theme.id).toBe('sunset-keynote');
    expect(planned.exportedPptx).toBeDefined();
    expect(planned.exportedPptx.slideCount).toBe(11);

    // Verify exported .pptx on disk parses back with the canvas-edited title and split slide
    const exportedBytes = new Uint8Array(
      await readFile(path.join(root, 'exports/slides/refined-showcase.pptx')),
    );
    const roundTrip = parsePptxBuffer(exportedBytes);
    expect(roundTrip.slides).toHaveLength(11);
    expect(roundTrip.slides[0].title).toBe('Canvas Edited Cover Title');
    expect(roundTrip.slides[2].title).toBe('AI Refined Bullet Slide');
    expect(roundTrip.slides[2].bullets).toHaveLength(3);
    expect(roundTrip.slides[3].title).toBe('AI Refined Bullet Slide (2/2)');
    expect(roundTrip.slides[3].bullets).toHaveLength(3);

    // Apply candidate and verify single-step undo/redo
    const applied = (await app.dispatch('projectApply', planned.apply)) as any;
    expect(applied.revision).toBe(planned.candidateRevision);
    expect(
      inspectSlides(app.service.snapshot, { source: 'components/slides/showcase.json' }).summary
        .totalSlides,
    ).toBe(11);

    const undone = (await app.dispatch('undo', {})) as any;
    expect(undone.snapshot?.revision ?? app.service.snapshot.revision).toBe(beforePlanRev);
    expect(
      inspectSlides(app.service.snapshot, { source: 'components/slides/showcase.json' }).summary
        .totalSlides,
    ).toBe(10);

    const redone = (await app.dispatch('redo', {})) as any;
    expect(redone.snapshot?.revision ?? app.service.snapshot.revision).toBe(
      planned.candidateRevision,
    );
  });

  it('rejects invalid .pptx archives and invalid slide plan actions with structured VmotionErrors', async () => {
    expect(() => parsePptxBuffer(new Uint8Array([1, 2, 3, 4]))).toThrowError(/Failed to unzip/);

    await expect(
      importSlides(root, app.service.snapshot, { id: 'bad' }),
    ).rejects.toMatchObject({ code: 'SLIDES_IMPORT_SOURCE' });

    await expect(
      planSlides(root, app.service.snapshot, {
        source: 'components/slides/showcase.json',
        actions: [{ type: 'updateSlide', slideId: 'non-existent', patch: { title: 'Nope' } }],
      }),
    ).rejects.toMatchObject({ code: 'SLIDES_NOT_FOUND' });

    await expect(
      planSlides(root, app.service.snapshot, {
        source: 'components/slides/showcase.json',
        actions: [{ type: 'reorderSlides', slideIds: ['slide-01'] }],
      }),
    ).rejects.toMatchObject({ code: 'SLIDES_ORDER' });
  });

  it('preserves embedded slide images, metrics delta, badge case, nested indents, and canvas slot edits across PPTX round-trips', async () => {
    // 1x1 valid RGBA PNG
    const tinyPng = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const mediaDeck: SlideDeckDocument = {
      id: 'media-roundtrip',
      name: 'Media & Slots Roundtrip',
      sequenceId: 'main',
      videoTrackId: 'video-1',
      theme: SLIDE_THEME_PRESETS['editorial-dark'],
      slides: [
        {
          id: 's-cover',
          layout: 'title-cover',
          badge: 'v0.2 Beta',
          title: 'Cover With Mixed Badge',
          bullets: [],
          metrics: [],
          notes: '',
          durationFrames: 90,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
        {
          id: 's-bullets',
          layout: 'bullet-points',
          title: 'Nested Bullets',
          bullets: ['Top item', '  Sub item', '    Deep item'],
          metrics: [],
          notes: '',
          durationFrames: 90,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
        {
          id: 's-cols',
          layout: 'two-column',
          title: 'Two Columns',
          bullets: [],
          left: { heading: 'Before', bullets: ['Old A'] },
          right: { heading: 'After', bullets: ['New B'] },
          metrics: [],
          notes: '',
          durationFrames: 90,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
        {
          id: 's-img',
          layout: 'image-split',
          title: 'Embedded Chart',
          bullets: ['Chart insight'],
          mediaAssetId: 'img-1',
          metrics: [],
          notes: '',
          durationFrames: 90,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
        {
          id: 's-metrics',
          layout: 'metrics-grid',
          title: 'Key Metrics',
          bullets: [],
          metrics: [
            { label: 'Aspect Ratio', value: '16:9', delta: '+100% HD' },
            { label: 'Export Time', value: '< 15 ms', delta: '-40%' },
          ],
          notes: '',
          durationFrames: 90,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
        {
          id: 's-quote',
          layout: 'quote',
          title: 'Quote',
          bullets: [],
          metrics: [],
          quote: 'Deterministic slides.',
          attribution: 'Original Author',
          notes: '',
          durationFrames: 90,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
        {
          id: 's-table',
          layout: 'comparison-table',
          title: 'Table',
          bullets: [],
          metrics: [],
          table: {
            headers: ['Tier', 'Latency'],
            rows: [['Local', '8 ms']],
          },
          notes: '',
          durationFrames: 90,
          animateEntrance: true,
          transition: { type: 'fade', durationFrames: 12 },
        },
      ],
    };

    const initialPptx = buildPptxBuffer(mediaDeck, {
      widthPx: 1920,
      heightPx: 1080,
      media: { 'img-1': { data: tinyPng, mimeType: 'image/png', ext: 'png' } },
    });
    const pptxInputPath = path.join(root, 'media-input.pptx');
    await writeFile(pptxInputPath, initialPptx);

    const imported = (await app.dispatch('slidesImport', {
      id: 'roundtrip',
      file: pptxInputPath,
      videoTrackId: 'video-1',
    })) as any;
    await app.dispatch('projectApply', imported.apply);

    // Edit two-column, metrics-grid, quote attribution, and table cell directly on canvas
    await app.service.transact([
      {
        type: 'updateNode',
        sceneId: 'roundtrip-slide-03',
        nodeId: 'roundtrip-slide-03/left-bullet-0',
        patch: { text: '• Canvas Left Updated' },
      },
      {
        type: 'updateNode',
        sceneId: 'roundtrip-slide-05',
        nodeId: 'roundtrip-slide-05/metric-value-0',
        patch: { text: '21:9' },
      },
      {
        type: 'updateNode',
        sceneId: 'roundtrip-slide-06',
        nodeId: 'roundtrip-slide-06/attribution',
        patch: { text: '— Canvas Author' },
      },
      {
        type: 'updateNode',
        sceneId: 'roundtrip-slide-07',
        nodeId: 'roundtrip-slide-07/table-td-0-1',
        patch: { text: '2 ms' },
      },
    ]);

    const inspected = inspectSlides(app.service.snapshot, {
      source: 'components/slides/roundtrip.json',
    });
    // Mixed-case badge untouched on canvas must NOT be uppercased
    expect(inspected.slides.items[0].badge).toBe('v0.2 Beta');
    // Nested bullet indents preserved through scene sync
    expect(inspected.slides.items[1].bullets).toEqual(['Top item', '  Sub item', '    Deep item']);
    // Canvas slot edits synced back across layouts
    expect(inspected.slides.items[2].left?.bullets[0]).toBe('Canvas Left Updated');
    expect(inspected.slides.items[4].metrics[0]).toEqual({
      label: 'Aspect Ratio',
      value: '21:9',
      delta: '+100% HD',
    });
    expect(inspected.slides.items[5].attribution).toBe('Canvas Author');
    expect(inspected.slides.items[6].table?.rows[0][1]).toBe('2 ms');

    // Export back to .pptx via slidesPlan and verify embedded PNG + metrics delta + canvas edits survive
    const exportedPlan = (await app.dispatch('slidesPlan', {
      source: 'components/slides/roundtrip.json',
      actions: [],
      exportPptx: { path: 'exports/slides/roundtrip-out.pptx' },
    })) as any;
    expect(exportedPlan.exportedPptx.bytes).toBeGreaterThan(1000);

    const outBytes = new Uint8Array(
      await readFile(path.join(root, 'exports/slides/roundtrip-out.pptx')),
    );
    const reparsed = parsePptxBuffer(outBytes);
    expect(reparsed.media.size).toBe(1);
    const extractedPng = [...reparsed.media.values()][0];
    expect(Buffer.compare(Buffer.from(extractedPng.data), Buffer.from(tinyPng))).toBe(0);
    expect(reparsed.slides[4].metrics[0]).toEqual({
      label: 'Aspect Ratio',
      value: '21:9',
      delta: '+100% HD',
    });
    expect(reparsed.slides[2].left?.bullets[0]).toBe('Canvas Left Updated');
    expect(reparsed.slides[5].attribution).toBe('Canvas Author');
    expect(reparsed.slides[6].table?.rows[0][1]).toBe('2 ms');
  });

  it('wraps slides_import in MCP planContract, differentiates slide-up transitions, and shrinks sequence duration on slide removal', async () => {
    const mcpImported = (await app.dispatch('agentToolInvoke', {
      name: 'slides_import',
      arguments: {
        id: 'mcp-deck',
        videoTrackId: 'video-1',
        slides: [
          {
            id: 'p1',
            layout: 'title-cover',
            title: 'Slide One',
            durationFrames: 120,
            transition: { type: 'slide-up', durationFrames: 15 },
          },
          {
            id: 'p2',
            layout: 'closing',
            title: 'Slide Two',
            durationFrames: 180,
            transition: { type: 'slide-up', durationFrames: 15 },
          },
        ],
      },
    })) as any;

    // MCP invokeTool returns { value, media } internally when called via app.dispatch('toolCall', ...)
    const envelope = mcpImported.value ?? mcpImported;
    expect(envelope.effect).toBe('plan');
    expect(envelope.committed).toBe(false);
    expect(envelope.plan?.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.plan?.candidateRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.next).toContain('project_preflight');

    await app.dispatch('projectApply', { planId: envelope.plan.planId });

    // Verify slide-up generates distinct entrance + exit vertical motion keyframes (4 keys on 'y')
    const p1Scene = app.service.snapshot.scenes.find((s) => s.id === 'mcp-deck-p1')!;
    const p1Title = p1Scene.nodes.find((n) => n.id === 'mcp-deck-p1/title')!;
    const yAnim = p1Title.animations?.find((a) => a.property === 'y');
    expect(yAnim?.keys.length).toBe(4);

    // Remove p2 and verify sequence duration shrinks instead of leaving trailing blank frames
    const beforeDuration = app.service.snapshot.sequences.find((s) => s.id === 'main')!.duration;
    const shrinkPlan = (await app.dispatch('slidesPlan', {
      source: 'components/slides/mcp-deck.json',
      actions: [{ type: 'removeSlides', slideIds: ['p2'] }],
    })) as any;
    expect(shrinkPlan.duration).toBeLessThan(beforeDuration);
  });
});
