import { describe, expect, it } from 'vitest';
import { buildSlideActions, slideDeckId, slideWarningText } from '../src/editor/studio/SlidesPanel.js';

const items = [
  { index: 0, id: 'a', sceneId: 'd-a', layout: 'title-cover', title: 'Cover', durationFrames: 90 },
  { index: 1, id: 'b', sceneId: 'd-b', layout: 'bullet-points', title: 'Points', bullets: ['1', '2', '3', '4', '5', '6'], notes: 'n', durationFrames: 120 },
  { index: 2, id: 'c', sceneId: 'd-c', layout: 'closing', title: 'End', durationFrames: 60 },
];
const drafts = Object.fromEntries(
  items.map((s) => [s.id, { layout: s.layout, title: s.title, durationFrames: s.durationFrames, notes: s.notes ?? '' }]),
);
const noBatch = { theme: '', transition: '', autoTiming: false, split: [] as string[] };

describe('slides panel action builder', () => {
  it('emits nothing for an untouched deck', () => {
    expect(buildSlideActions(items, ['a', 'b', 'c'], drafts, [], noBatch)).toEqual([]);
  });

  it('maps edits, removals, order and batch options to slides_plan actions', () => {
    const actions = buildSlideActions(
      items,
      ['c', 'a', 'b'],
      { ...drafts, a: { ...drafts.a!, layout: 'section-header', title: 'New cover', notes: 'hello' }, c: { ...drafts.c!, durationFrames: 30 } },
      [],
      { theme: 'executive-light', transition: 'fade', autoTiming: true, split: ['b'] },
    );
    expect(actions).toEqual([
      { type: 'reorderSlides', slideIds: ['c', 'a', 'b'] },
      { type: 'updateSlide', slideId: 'a', patch: { layout: 'section-header', title: 'New cover', notes: 'hello' } },
      { type: 'updateSlide', slideId: 'c', patch: { durationFrames: 30 } },
      { type: 'splitSlide', slideId: 'b', maxBulletsPerSlide: 4 },
      { type: 'applyTheme', preset: 'executive-light' },
      { type: 'setTransitions', transition: { type: 'fade', durationFrames: 12 } },
      { type: 'autoTiming', minDurationFrames: 60, maxDurationFrames: 900 },
    ]);
  });

  it('drops edits on removed slides and does not report a reorder caused only by removal', () => {
    const actions = buildSlideActions(
      items,
      ['a', 'b', 'c'],
      { ...drafts, b: { ...drafts.b!, title: 'ignored' } },
      ['b'],
      { ...noBatch, split: ['b'] },
    );
    expect(actions).toEqual([{ type: 'removeSlides', slideIds: ['b'] }]);
  });

  it('ignores a blanked title instead of sending an invalid patch', () => {
    expect(buildSlideActions(items, ['a', 'b', 'c'], { ...drafts, a: { ...drafts.a!, title: '  ' } }, [], noBatch)).toEqual([]);
  });

  it('derives safe deck ids and localizes readability warnings', () => {
    expect(slideDeckId('Q3 汇报 (final).pptx')).toBe('Q3-final');
    expect(slideDeckId('汇报.pptx')).toBe('deck');
    expect(slideWarningText('Slide has 9 bullet points; consider splitting across two slides')).toBe('共 9 条要点，建议拆成两页');
    expect(slideWarningText('Title exceeds 72 characters and may wrap past 2 lines')).toContain('标题过长');
  });
});
