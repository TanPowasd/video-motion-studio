import React, { useEffect, useMemo, useState } from 'react';
import type { StudioContext } from './types.js';
import { CandidateActions, NumberControl, PanelIntro, SelectControl, Toggle } from './Controls.js';

const LAYOUTS: Array<[string, string]> = [
  ['title-cover', '封面'],
  ['section-header', '章节页'],
  ['bullet-points', '要点'],
  ['two-column', '双栏'],
  ['image-split', '图文'],
  ['metrics-grid', '数据卡片'],
  ['quote', '引言'],
  ['code-walkthrough', '代码讲解'],
  ['comparison-table', '对比表格'],
  ['closing', '结束页'],
];
const THEMES: Array<[string, string]> = [
  ['editorial-dark', '深色编辑'],
  ['executive-light', '浅色商务'],
  ['emerald-tech', '翠绿科技'],
  ['sunset-keynote', '日落发布会'],
];
const TRANSITIONS: Array<[string, string]> = [
  ['', '保持不变'],
  ['none', '无'],
  ['fade', '淡入淡出'],
  ['slide-up', '上推'],
];
const MAX_IMPORT_BYTES = 12 * 1024 * 1024;

type SlideItem = {
  index: number;
  id: string;
  sceneId: string;
  layout: string;
  title: string;
  bullets?: string[];
  notes?: string;
  durationFrames: number;
  readability?: { warnings: string[] };
};
type Inspect = {
  revision: string;
  source: string;
  hash: string;
  id: string;
  name: string;
  theme?: { id?: string };
  summary: { totalSlides: number; totalDurationFrames: number; slidesWithNotes: number; overflowWarnings: number };
  slides: { items: SlideItem[] };
};
type Draft = { layout: string; title: string; durationFrames: number; notes: string };

/** Readability diagnostics come from the service in English; show them in the UI language. */
export function slideWarningText(message: string) {
  if (message.startsWith('Title exceeds')) return '标题过长，可能折成三行以上';
  const bullets = /^Slide has (\d+) bullet points/.exec(message);
  if (bullets) return `共 ${bullets[1]} 条要点，建议拆成两页`;
  if (message.startsWith('One or more bullet')) return '有要点超过 140 字';
  if (message.startsWith('Code block exceeds')) return '代码超过 16 行，1080p 画面可能被裁切';
  return message;
}

export function slideDeckId(fileName: string) {
  const base = fileName.replace(/\.pptx$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'deck').slice(0, 60);
}

/** Turn the panel's draft edits into slides_plan actions (pure, so it is unit-tested). */
export function buildSlideActions(
  items: SlideItem[],
  order: string[],
  drafts: Record<string, Draft>,
  removed: string[],
  batch: { theme: string; transition: string; autoTiming: boolean; split: string[] },
) {
  const actions: any[] = [];
  const removedSet = new Set(removed);
  const kept = order.filter((id) => !removedSet.has(id));
  if (removed.length) actions.push({ type: 'removeSlides', slideIds: removed });
  const original = items.map((s) => s.id).filter((id) => !removedSet.has(id));
  if (kept.join('\n') !== original.join('\n')) actions.push({ type: 'reorderSlides', slideIds: kept });
  for (const item of items) {
    const draft = drafts[item.id];
    if (!draft || removedSet.has(item.id)) continue;
    const patch: Record<string, unknown> = {};
    if (draft.layout !== item.layout) patch.layout = draft.layout;
    if (draft.title.trim() && draft.title !== item.title) patch.title = draft.title;
    if (draft.durationFrames !== item.durationFrames) patch.durationFrames = draft.durationFrames;
    if (draft.notes !== (item.notes ?? '')) patch.notes = draft.notes;
    if (Object.keys(patch).length) actions.push({ type: 'updateSlide', slideId: item.id, patch });
  }
  for (const id of batch.split) if (!removedSet.has(id)) actions.push({ type: 'splitSlide', slideId: id, maxBulletsPerSlide: 4 });
  if (batch.theme) actions.push({ type: 'applyTheme', preset: batch.theme });
  if (batch.transition)
    actions.push({ type: 'setTransitions', transition: { type: batch.transition, durationFrames: 12 } });
  if (batch.autoTiming) actions.push({ type: 'autoTiming', minDurationFrames: 60, maxDurationFrames: 900 });
  return actions;
}

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });

export default function SlidesPanel({ context }: { context: StudioContext }) {
  const decks = Object.keys(context.snapshot.files)
    .filter((f) => /^components\/slides\/.+\.json$/.test(f))
    .sort();
  const fps = context.snapshot.project.fps.num / context.snapshot.project.fps.den;
  const [mode, setMode] = useState(decks.length ? 'edit' : 'import'),
    [source, setSource] = useState(decks[0] ?? ''),
    [info, setInfo] = useState<Inspect>(),
    [loadError, setLoadError] = useState(''),
    [file, setFile] = useState<{ name: string; size: number; base64: string }>(),
    [deckId, setDeckId] = useState('main-deck'),
    [importTheme, setImportTheme] = useState('editorial-dark'),
    [seconds, setSeconds] = useState(6),
    [order, setOrder] = useState<string[]>([]),
    [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [removed, setRemoved] = useState<string[]>([]),
    [split, setSplit] = useState<string[]>([]),
    [theme, setTheme] = useState(''),
    [transition, setTransition] = useState(''),
    [autoTiming, setAutoTiming] = useState(false),
    [exportName, setExportName] = useState(''),
    [exporting, setExporting] = useState(false),
    [exported, setExported] = useState<{ path: string; bytes: number; slideCount: number }>(),
    [exportError, setExportError] = useState('');

  useEffect(() => {
    if (!source) {
      setInfo(undefined);
      return;
    }
    let live = true;
    setLoadError('');
    context
      .run('slidesInspect', { source, limit: 100 })
      .then((result: Inspect) => {
        if (!live) return;
        setInfo(result);
        setOrder(result.slides.items.map((s) => s.id));
        setDrafts(
          Object.fromEntries(
            result.slides.items.map((s) => [
              s.id,
              { layout: s.layout, title: s.title, durationFrames: s.durationFrames, notes: s.notes ?? '' },
            ]),
          ),
        );
        setRemoved([]);
        setSplit([]);
        setTheme('');
        setTransition('');
        setAutoTiming(false);
        setExportName((name) => name || `${result.id}.pptx`);
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [source, context.snapshot.revision]);

  const items = info?.slides.items ?? [];
  const byId = useMemo(() => new Map(items.map((s) => [s.id, s])), [items]);
  const actions = useMemo(
    () => buildSlideActions(items, order, drafts, removed, { theme, transition, autoTiming, split }),
    [items, order, drafts, removed, theme, transition, autoTiming, split],
  );
  const move = (id: string, delta: number) =>
    setOrder((list) => {
      const next = [...list],
        index = next.indexOf(id),
        to = index + delta;
      if (index < 0 || to < 0 || to >= next.length) return list;
      next.splice(to, 0, ...next.splice(index, 1));
      return next;
    });
  const patch = (id: string, value: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...value } }));
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((v) => v !== id) : [...list, id];
  const exportPath = `exports/slides/${slideDeckId(exportName || info?.id || 'deck')}.pptx`;

  return (
    <>
      <PanelIntro title="演示文稿">
        导入 PowerPoint（.pptx）后，每页都会变成可编辑的场景并排进时间轴。可在这里换版式、改标题与讲稿、调整顺序，再导出回 .pptx。
      </PanelIntro>
      <div className="studio-tools">
        <button className={mode === 'import' ? 'pressed' : ''} onClick={() => setMode('import')}>
          导入 PPTX
        </button>
        <button
          className={mode === 'edit' ? 'pressed' : ''}
          disabled={!decks.length}
          onClick={() => setMode('edit')}
        >
          批量改页
        </button>
        <button
          className={mode === 'export' ? 'pressed' : ''}
          disabled={!decks.length}
          onClick={() => setMode('export')}
        >
          导出 PPTX
        </button>
        {mode !== 'import' && decks.length > 1 && (
          <SelectControl
            label="演示文稿"
            value={source}
            options={decks.map((f) => [f, f.replace(/^components\/slides\//, '')] as [string, string])}
            onChange={setSource}
          />
        )}
      </div>

      {mode === 'import' && (
        <>
          <div className="studio-grid">
            <label className="studio-field slides-file">
              <span>PowerPoint 文件</span>
              <input
                aria-label="选择 PPTX 文件"
                type="file"
                accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (!picked) return setFile(undefined);
                  if (picked.size > MAX_IMPORT_BYTES) {
                    setFile(undefined);
                    setLoadError('文件超过 12 MB；大文件请用 vmotion slides import --file 导入');
                    return;
                  }
                  setLoadError('');
                  setDeckId(slideDeckId(picked.name));
                  void readBase64(picked).then((base64) =>
                    setFile({ name: picked.name, size: picked.size, base64 }),
                  );
                }}
              />
            </label>
            <label className="studio-field">
              <span>文稿 ID</span>
              <input
                aria-label="文稿 ID"
                value={deckId}
                onChange={(e) => setDeckId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
              />
            </label>
            <SelectControl label="主题" value={importTheme} options={THEMES} onChange={setImportTheme} />
            <NumberControl
              label="无讲稿页时长（秒）"
              value={seconds}
              min={1}
              max={600}
              onChange={(v) => setSeconds(Math.max(1, v))}
            />
          </div>
          {file && (
            <p className="slides-meta">
              {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
              {decks.includes(`components/slides/${deckId}.json`) && ' · 将覆盖同名文稿'}
            </p>
          )}
          {loadError && (
            <p className="studio-error" role="alert">
              {loadError}
            </p>
          )}
          {file ? (
            <CandidateActions
              context={context}
              changeKey={`${file.name}:${file.size}:${deckId}:${importTheme}:${seconds}`}
              prepare={() =>
                context.run('slidesImport', {
                  revision: context.snapshot.revision,
                  pptxBase64: file.base64,
                  id: deckId || 'main-deck',
                  name: file.name.replace(/\.pptx$/i, ''),
                  theme: importTheme,
                  defaultDurationFrames: Math.max(15, Math.round(seconds * fps)),
                })
              }
            />
          ) : (
            <div className="studio-empty">
              <strong>选择一个 .pptx 文件</strong>
              <p>文字、要点、表格、图片和讲稿备注会一起导入；导入前可先预览检查。</p>
            </div>
          )}
        </>
      )}

      {mode === 'edit' && (
        <>
          {loadError && (
            <p className="studio-error" role="alert">
              {loadError}
            </p>
          )}
          {info && (
            <>
              <div className="inspection-metrics slides-summary">
                <span>
                  <strong>{info.summary.totalSlides}</strong>页
                </span>
                <span>
                  <strong>{(info.summary.totalDurationFrames / fps).toFixed(1)}</strong>秒
                </span>
                <span>
                  <strong>{info.summary.slidesWithNotes}</strong>页有讲稿
                </span>
                <span>
                  <strong>{info.summary.overflowWarnings}</strong>处排版提醒
                </span>
              </div>
              <div className="studio-grid">
                <SelectControl
                  label="统一主题"
                  value={theme}
                  options={[['', `保持不变（${THEMES.find(([id]) => id === info.theme?.id)?.[1] ?? '自定义'}）`], ...THEMES]}
                  onChange={setTheme}
                />
                <SelectControl label="统一转场" value={transition} options={TRANSITIONS} onChange={setTransition} />
                <Toggle label="按讲稿字数自动配时" value={autoTiming} onChange={setAutoTiming} />
              </div>
              <ol className="slide-rows" aria-label="幻灯片">
                {order.map((id, position) => {
                  const item = byId.get(id),
                    draft = drafts[id];
                  if (!item || !draft) return null;
                  const gone = removed.includes(id);
                  return (
                    <li key={id} className={gone ? 'removed' : ''}>
                      <img
                        alt={`第 ${position + 1} 页预览`}
                        loading="lazy"
                        src={`/api/frame?frame=${Math.floor(item.durationFrames / 2)}&width=240&height=135&scene=${encodeURIComponent(item.sceneId)}&revision=${info.revision}`}
                      />
                      <div className="slide-fields">
                        <div className="slide-row-head">
                          <span className="shot-index">{position + 1}</span>
                          <input
                            aria-label={`第 ${position + 1} 页标题`}
                            value={draft.title}
                            disabled={gone}
                            onChange={(e) => patch(id, { title: e.target.value })}
                          />
                        </div>
                        <div className="slide-row-controls">
                          <SelectControl
                            label="版式"
                            value={draft.layout}
                            options={LAYOUTS}
                            onChange={(layout) => patch(id, { layout })}
                          />
                          <NumberControl
                            label="时长（秒）"
                            value={Number((draft.durationFrames / fps).toFixed(2))}
                            min={0.5}
                            step={0.5}
                            commitOnBlur
                            onChange={(v) =>
                              patch(id, { durationFrames: Math.max(15, Math.round(v * fps)) })
                            }
                          />
                        </div>
                        <label className="studio-field">
                          <span>讲稿备注</span>
                          <textarea
                            aria-label={`第 ${position + 1} 页讲稿`}
                            rows={2}
                            value={draft.notes}
                            disabled={gone}
                            onChange={(e) => patch(id, { notes: e.target.value })}
                          />
                        </label>
                        {!!item.readability?.warnings.length && (
                          <p className="slide-warning">
                            {item.readability.warnings.map(slideWarningText).join('；')}
                          </p>
                        )}
                      </div>
                      <div className="slide-row-actions">
                        <button aria-label="上移" disabled={position === 0} onClick={() => move(id, -1)}>
                          ↑
                        </button>
                        <button
                          aria-label="下移"
                          disabled={position === order.length - 1}
                          onClick={() => move(id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          className={split.includes(id) ? 'pressed' : ''}
                          disabled={gone || (item.bullets?.length ?? 0) <= 4}
                          title="每页最多 4 条要点"
                          onClick={() => setSplit((l) => toggle(l, id))}
                        >
                          拆页
                        </button>
                        <button
                          className={gone ? 'pressed' : ''}
                          onClick={() => setRemoved((l) => toggle(l, id))}
                        >
                          {gone ? '恢复' : '删除'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="slides-meta">
                {actions.length ? `待提交 ${actions.length} 项修改` : '还没有修改'}
              </p>
              {actions.length > 0 && (
                <CandidateActions
                  context={context}
                  changeKey={JSON.stringify([info.hash, actions])}
                  prepare={() =>
                    context.run('slidesPlan', {
                      revision: context.snapshot.revision,
                      source: info.source,
                      expectedHash: info.hash,
                      actions,
                    })
                  }
                />
              )}
            </>
          )}
        </>
      )}

      {mode === 'export' && info && (
        <>
          <div className="studio-grid">
            <label className="studio-field">
              <span>文件名</span>
              <input aria-label="导出文件名" value={exportName} onChange={(e) => setExportName(e.target.value)} />
            </label>
          </div>
          <p className="slides-meta">
            导出已保存的版本（{info.summary.totalSlides} 页）到 {exportPath}
            {actions.length > 0 && '；批量改页里还有未应用的修改，不会包含在内'}
          </p>
          <div className="candidate-bar">
            <div className="candidate-buttons">
              <button
                className="primary"
                disabled={exporting}
                onClick={() => {
                  setExporting(true);
                  setExportError('');
                  setExported(undefined);
                  context
                    .run('slidesPlan', {
                      source: info.source,
                      expectedHash: info.hash,
                      actions: [],
                      exportPptx: { path: exportPath },
                    })
                    .then((result: any) => setExported(result.exportedPptx))
                    .catch((e: Error) => setExportError(e.message))
                    .finally(() => setExporting(false));
                }}
              >
                {exporting ? '正在导出…' : '导出 PPTX'}
              </button>
              {exported && (
                <>
                  <a
                    className="secondary"
                    href={`/api/export?file=${encodeURIComponent(exported.path.replace(/^exports\//, ''))}`}
                    download
                  >
                    下载
                  </a>
                  {window.vmotionDesktop && (
                    <button className="secondary" onClick={() => void window.vmotionDesktop!.showFile(exported.path)}>
                      在文件夹中显示
                    </button>
                  )}
                  <span>
                    已导出 {exported.slideCount} 页 · {(exported.bytes / 1024).toFixed(0)} KB
                  </span>
                </>
              )}
            </div>
            {exportError && (
              <p className="studio-error" role="alert">
                {exportError}
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
