/**
 * Studio shell model: the six creative modes, per-project layout persistence, mode
 * shortcuts and responsive rules. Pure functions so they can be unit tested without a DOM.
 */
export type StudioMode = 'edit' | 'motion' | 'effects' | 'music' | 'still' | 'type';
export interface ModeInfo {
  id: StudioMode;
  name: string;
  icon: string;
  keys: string;
  hint: string;
}
export const MODES: ModeInfo[] = [
  { id: 'edit', name: '剪辑', icon: 'film', keys: 'Ctrl+1', hint: '素材库、代理与多轨时间线' },
  { id: 'motion', name: '动效', icon: 'layers', keys: 'Ctrl+2', hint: '关键帧、曲线、动画层与动作模板' },
  { id: 'effects', name: '特效', icon: 'sparkles', keys: 'Ctrl+3', hint: '效果堆栈、节点图、粒子、抠像与转场' },
  { id: 'music', name: '音乐', icon: 'music', keys: 'Ctrl+4', hint: '编曲、通道架、钢琴卷帘、合成器与混音' },
  { id: 'still', name: '图片', icon: 'image', keys: 'Ctrl+5', hint: '单帧画板、对齐吸附与图片导出' },
  { id: 'type', name: '文字', icon: 'text', keys: 'Ctrl+6', hint: '排版、逐字动画、路径文字、字幕与字形库' },
];
export const modeInfo = (mode: StudioMode) => MODES.find((m) => m.id === mode)!;

export type RightTab = 'changes' | 'inspector';
export interface StudioLayout {
  mode: StudioMode;
  left: number;
  right: number;
  timeline: number;
  showLeft: boolean;
  showRight: boolean;
  showTimeline: boolean;
  rightTab: RightTab;
  /** Auto-reveal what an external AI just changed (scene, object, playhead). */
  followAi: boolean;
  /** Collapsed state of the 图层/素材 section under the scene strip. */
  showLayers: boolean;
}
export const studioDefaults: StudioLayout = {
  mode: 'motion',
  left: 264,
  right: 336,
  timeline: 252,
  showLeft: true,
  showRight: true,
  showTimeline: true,
  rightTab: 'changes',
  followAi: true,
  showLayers: true,
};
export const studioLimits = {
  left: { min: 208, max: 420 },
  right: { min: 280, max: 520 },
  timeline: { min: 150, max: 560 },
} as const;
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : fallback;
};
export const layoutKey = (projectId: string) => `vmotion.studio.layout.${projectId}`;
/** Sanitises a stored layout (older/corrupt values fall back to defaults). */
export function parseLayout(raw: unknown): StudioLayout {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    mode: MODES.some((m) => m.id === v.mode) ? (v.mode as StudioMode) : studioDefaults.mode,
    left: clamp(v.left, studioLimits.left.min, studioLimits.left.max, studioDefaults.left),
    right: clamp(v.right, studioLimits.right.min, studioLimits.right.max, studioDefaults.right),
    timeline: clamp(
      v.timeline,
      studioLimits.timeline.min,
      studioLimits.timeline.max,
      studioDefaults.timeline,
    ),
    showLeft: v.showLeft !== false,
    showRight: v.showRight !== false,
    showTimeline: v.showTimeline !== false,
    rightTab: v.rightTab === 'inspector' ? 'inspector' : 'changes',
    followAi: v.followAi !== false,
    showLayers: v.showLayers !== false,
  };
}
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;
export function readLayout(storage: KeyValueStore, projectId: string): StudioLayout {
  try {
    return parseLayout(JSON.parse(storage.getItem(layoutKey(projectId)) ?? '{}'));
  } catch {
    return { ...studioDefaults };
  }
}
export function writeLayout(storage: KeyValueStore, projectId: string, layout: StudioLayout) {
  try {
    storage.setItem(layoutKey(projectId), JSON.stringify(layout));
  } catch {
    /* storage full / disabled: layout simply isn't remembered */
  }
}

/** Which backing workspace a mode uses in the existing controller. */
export function workspaceForMode(mode: StudioMode): 'editing' | 'animation' | 'music' {
  return mode === 'edit' ? 'editing' : mode === 'music' ? 'music' : 'animation';
}
/**
 * Mode implied by the current route/workspace. Used when the user arrives by URL or by an
 * existing action (e.g. "打开画稿", entering a still scene) so the pill stays truthful.
 */
export function inferMode(
  current: StudioMode,
  workspace: string,
  hash: string,
  stillScene: boolean,
): StudioMode {
  if (hash.startsWith('#/music')) return 'music';
  if (workspace === 'editing') return 'edit';
  if (workspace === 'animation') {
    if (stillScene) return 'still';
    if (current === 'still' || current === 'edit' || current === 'music') return 'motion';
    return current;
  }
  return current;
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
/** Ctrl/Cmd+1…6 switches modes (replaces the old Ctrl+1…5 workspace keys). */
export function modeFromShortcut(e: KeyLike): StudioMode | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return undefined;
  const digit = /^Digit([1-6])$/.exec(e.code ?? '')?.[1] ?? (/^[1-6]$/.test(e.key) ? e.key : '');
  return digit ? MODES[Number(digit) - 1].id : undefined;
}

export interface Responsive {
  /** Change feed / inspector become an overlay drawer instead of a column. */
  rightDrawer: boolean;
  /** Scene strip shows compact cards (number + badge). */
  compactStrip: boolean;
  /** Top bar hides secondary labels. */
  compactTop: boolean;
}
export function responsive(width: number): Responsive {
  return {
    rightDrawer: width < 1240,
    compactStrip: width < 1000,
    compactTop: width < 1500,
  };
}
