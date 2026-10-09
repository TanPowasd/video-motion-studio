/* CSS-like style subset for JSX elements, lowered onto existing node properties. */
import { VmotionError, type Gradient } from '../core/model.js';

type Affine = [number, number, number, number, number, number];
const mul = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];

/** Style keys accepted on JSX elements. Values are numbers (px) or CSS-like strings. */
export interface VmStyle {
  position?: 'absolute';
  left?: number | string;
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  width?: number | string;
  height?: number | string;
  transform?: string;
  transformOrigin?: string;
  opacity?: number;
  visibility?: 'visible' | 'hidden';
  display?: 'block' | 'none';
  zIndex?: number;
  background?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  fill?: string;
  color?: string;
  stroke?: string;
  strokeWidth?: number | string;
  border?: string;
  borderWidth?: number | string;
  borderColor?: string;
  borderRadius?: number | string;
  boxShadow?: string;
  textShadow?: string;
  filter?: string;
  mixBlendMode?: string;
  fontSize?: number | string;
  fontFamily?: string;
  fontWeight?: number | string;
  textAlign?: 'left' | 'center' | 'right';
  lineHeight?: number | string;
}

/** Keys that are recognised CSS but not supported, with the Vmotion alternative. */
const unsupportedStyle: Array<[RegExp, string]> = [
  [
    /^(margin|padding|flex|grid|gap|justify|align(Items|Content|Self)|order|rowGap|columnGap|inset|float|clear)/,
    'Batch 1 JSX uses absolute positioning only: compute x/y (left/top) in code, e.g. index * spacing. Flex/grid layout is planned (batch 2).',
  ],
  [
    /^(transition|animation)/,
    'There is no CSS timeline: derive values from useClock() with remap()/springTo() so every frame is seekable.',
  ],
  [
    /^(cursor|pointerEvents|userSelect|touchAction|outline|resize|scroll)/,
    'Vmotion renders frames offline; interaction styles have no effect.',
  ],
  [
    /^(perspective|backfaceVisibility|transformStyle)/,
    'True 3D CSS is not supported; use project3D()/matrix helpers or the pseudo-3D pattern in docs/JSX-COMPONENTS.md.',
  ],
  [/^(overflow|clipPath|mask)/, 'Use the clip prop ({x,y,width,height}) or maskId on the node.'],
  [
    /^(letterSpacing|textTransform|textDecoration|whiteSpace|wordBreak|textOverflow|fontStyle)/,
    'Use textAnimators/pathText node props or pre-format the string; this text style is not mapped in batch 1.',
  ],
];

export interface StyleBox {
  /** Parent box for % units. */
  parent: { width: number; height: number };
  /** Element size (explicit or default) for transform-origin and gradients. */
  self: { width: number; height: number };
  fontSize?: number;
}

const fail = (code: string, message: string, details: Record<string, unknown>) => {
  throw new VmotionError(code, message, details);
};

export function length(value: number | string, basis: number, where: string, at: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JSX_STYLE_VALUE', `${where} must be finite`, { at });
    return value;
  }
  const m = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*(px|%)?\s*$/i.exec(value);
  if (!m)
    fail(
      'JSX_STYLE_VALUE',
      `${where}: "${value}" is not a supported length; use a number (px), "12px" or "50%"`,
      { at },
    );
  const n = Number(m![1]);
  return m![2] === '%' ? (n / 100) * basis : n;
}
export function angle(value: string | number, at: string): number {
  if (typeof value === 'number') return value;
  const m = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*(deg|rad|turn|grad)?\s*$/i.exec(value);
  if (!m) fail('JSX_STYLE_VALUE', `"${value}" is not an angle (deg/rad/turn)`, { at });
  const n = Number(m![1]),
    unit = (m![2] ?? 'deg').toLowerCase();
  return unit === 'rad'
    ? (n * 180) / Math.PI
    : unit === 'turn'
      ? n * 360
      : unit === 'grad'
        ? n * 0.9
        : n;
}
const splitArgs = (text: string) => {
  const parts: string[] = [];
  let depth = 0,
    current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
};
const splitSpaces = (text: string) => {
  const parts: string[] = [];
  let depth = 0,
    current = '';
  for (const ch of text.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
};

export interface TransformResult {
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  matrix?: Affine;
}
/**
 * Parse a CSS transform list. Canonical translate → rotate → scale lists map to editable
 * x/y/rotation/scale props; any other order (or skew/matrix) is composed exactly into `matrix`.
 */
export function parseTransform(
  value: string,
  box: StyleBox,
  origin: { x: number; y: number },
  at: string,
): TransformResult {
  const functions: Array<{ name: string; args: string[] }> = [];
  const re = /([a-zA-Z0-9]+)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m: RegExpExecArray | null,
    consumed = '';
  while ((m = re.exec(value))) {
    functions.push({ name: m[1], args: splitArgs(m[2]) });
    consumed += m[0];
  }
  if (value.replace(/\s+/g, '') !== consumed.replace(/\s+/g, '') && value.trim() !== 'none')
    fail('JSX_STYLE_VALUE', `transform "${value}" could not be parsed`, { at });
  const W = box.self.width,
    H = box.self.height;
  const ops: Array<{ kind: 't' | 'r' | 's' | 'm'; m: Affine; v: number[] }> = [];
  for (const f of functions) {
    const a = f.args;
    switch (f.name) {
      case 'translate':
      case 'translateX':
      case 'translateY': {
        const tx = f.name === 'translateY' ? 0 : length(a[0] ?? 0, W, 'translate', at),
          ty =
            f.name === 'translateX'
              ? 0
              : f.name === 'translateY'
                ? length(a[0] ?? 0, H, 'translate', at)
                : length(a[1] ?? 0, H, 'translate', at);
        ops.push({ kind: 't', m: translate(tx, ty), v: [tx, ty] });
        break;
      }
      case 'scale':
      case 'scaleX':
      case 'scaleY': {
        const sx = f.name === 'scaleY' ? 1 : Number(a[0]),
          sy = f.name === 'scaleX' ? 1 : f.name === 'scaleY' ? Number(a[0]) : Number(a[1] ?? a[0]);
        if (!Number.isFinite(sx) || !Number.isFinite(sy))
          fail('JSX_STYLE_VALUE', `scale() needs numbers in "${value}"`, { at });
        ops.push({ kind: 's', m: [sx, 0, 0, sy, 0, 0], v: [sx, sy] });
        break;
      }
      case 'rotate':
      case 'rotateZ': {
        const deg = angle(a[0] ?? '0', at),
          r = (deg * Math.PI) / 180;
        ops.push({
          kind: 'r',
          m: [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0],
          v: [deg],
        });
        break;
      }
      case 'skew':
      case 'skewX':
      case 'skewY': {
        const ax = f.name === 'skewY' ? 0 : angle(a[0] ?? '0', at),
          ay =
            f.name === 'skewX'
              ? 0
              : f.name === 'skewY'
                ? angle(a[0] ?? '0', at)
                : angle(a[1] ?? '0', at);
        ops.push({
          kind: 'm',
          m: [1, Math.tan((ay * Math.PI) / 180), Math.tan((ax * Math.PI) / 180), 1, 0, 0],
          v: [],
        });
        break;
      }
      case 'matrix': {
        const v = a.map(Number);
        if (v.length !== 6 || v.some((n) => !Number.isFinite(n)))
          fail('JSX_STYLE_VALUE', 'matrix() needs six numbers', { at });
        ops.push({ kind: 'm', m: v as Affine, v: [] });
        break;
      }
      case 'rotateX':
      case 'rotateY':
      case 'rotate3d':
      case 'perspective':
      case 'translate3d':
      case 'translateZ':
      case 'scale3d':
      case 'scaleZ':
      case 'matrix3d':
        fail(
          'JSX_STYLE_UNSUPPORTED',
          `transform ${f.name}() is 3D CSS and is not supported. Use project3D()/matrix3d helpers, or fake depth with scaleX = cos(angle) plus skewY (see docs/JSX-COMPONENTS.md).`,
          { at, key: 'transform' },
        );
        break;
      default:
        fail('JSX_STYLE_VALUE', `Unknown transform function ${f.name}()`, { at });
    }
  }
  // Canonical order translate* rotate? scale? maps onto editable node properties.
  let index = 0,
    tx = 0,
    ty = 0;
  while (ops[index]?.kind === 't') {
    tx += ops[index].v[0];
    ty += ops[index].v[1];
    index++;
  }
  let rotation = 0,
    sx = 1,
    sy = 1;
  if (ops[index]?.kind === 'r') rotation = ops[index++].v[0];
  if (ops[index]?.kind === 's') {
    sx = ops[index].v[0];
    sy = ops[index++].v[1];
  }
  if (index === ops.length) {
    const out: TransformResult = {};
    if (tx) out.x = tx;
    if (ty) out.y = ty;
    if (rotation) out.rotation = rotation;
    if (sx !== 1) out.scaleX = sx;
    if (sy !== 1) out.scaleY = sy;
    return out;
  }
  let total: Affine = [1, 0, 0, 1, 0, 0];
  for (const op of ops) total = mul(total, op.m);
  return {
    matrix: mul(mul(translate(origin.x, origin.y), total), translate(-origin.x, -origin.y)),
  };
}

export function parseOrigin(value: string, self: { width: number; height: number }, at: string) {
  const words = splitSpaces(value.toLowerCase());
  const pick = (word: string | undefined, basis: number, axis: 'x' | 'y') => {
    if (word === undefined || word === 'center') return basis / 2;
    if ((axis === 'x' && word === 'left') || (axis === 'y' && word === 'top')) return 0;
    if ((axis === 'x' && word === 'right') || (axis === 'y' && word === 'bottom')) return basis;
    return length(word, basis, 'transformOrigin', at);
  };
  let [first, second] = words;
  if (first === 'top' || first === 'bottom') [first, second] = [second ?? 'center', first];
  return { x: pick(first, self.width, 'x'), y: pick(second, self.height, 'y') };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
export function parseGradient(
  value: string,
  self: { width: number; height: number },
  at: string,
): Gradient {
  const m = /^\s*(linear|radial)-gradient\((.*)\)\s*$/i.exec(value);
  if (!m)
    fail(
      'JSX_STYLE_VALUE',
      `"${value}" is not a supported gradient; use linear-gradient(...) or radial-gradient(...)`,
      { at },
    );
  const kind = m![1].toLowerCase(),
    args = splitArgs(m![2]);
  let first = args[0] ?? '';
  let deg = 180;
  const directions: Record<string, number> = {
    'to top': 0,
    'to right': 90,
    'to bottom': 180,
    'to left': 270,
    'to top right': 45,
    'to right top': 45,
    'to bottom right': 135,
    'to right bottom': 135,
    'to bottom left': 225,
    'to left bottom': 225,
    'to top left': 315,
    'to left top': 315,
  };
  let colorArgs = args;
  if (kind === 'linear' && (/^-?[\d.]+(deg|rad|turn|grad)$/.test(first) || first in directions)) {
    deg = first in directions ? directions[first] : angle(first, at);
    colorArgs = args.slice(1);
  } else if (kind === 'radial' && /^(circle|ellipse|closest|farthest|at\s)/.test(first)) {
    colorArgs = args.slice(1);
  }
  if (colorArgs.length < 2) fail('JSX_STYLE_VALUE', 'Gradients need at least two colors', { at });
  const stops = colorArgs.map((part, i) => {
    const words = splitSpaces(part),
      last = words.at(-1)!,
      hasOffset = words.length > 1 && /%$/.test(last);
    return {
      color: hasOffset ? words.slice(0, -1).join(' ') : part,
      offset: hasOffset
        ? Math.max(0, Math.min(1, Number(last.slice(0, -1)) / 100))
        : i / (colorArgs.length - 1),
    };
  });
  const { width: W, height: H } = self;
  if (kind === 'radial')
    return {
      type: 'radial',
      center: { x: W / 2, y: H / 2 },
      radius: Math.max(1, Math.hypot(W, H) / 2),
      stops,
    };
  const r = (deg * Math.PI) / 180,
    dx = Math.sin(r),
    dy = -Math.cos(r),
    half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
  return {
    type: 'linear',
    from: { x: round6(W / 2 - dx * half), y: round6(H / 2 - dy * half) },
    to: { x: round6(W / 2 + dx * half), y: round6(H / 2 + dy * half) },
    stops,
  };
}

const parseShadow = (value: string, at: string) => {
  const words = splitSpaces(value);
  const lengths: number[] = [],
    color: string[] = [];
  for (const w of words)
    if (/^-?[\d.]+(px)?$/.test(w)) lengths.push(parseFloat(w));
    else if (w === 'inset')
      fail('JSX_STYLE_UNSUPPORTED', 'inset shadows are not supported', { at, key: 'boxShadow' });
    else color.push(w);
  if (lengths.length < 2)
    fail('JSX_STYLE_VALUE', `shadow "${value}" needs at least x and y offsets`, { at });
  return {
    x: lengths[0],
    y: lengths[1],
    blur: Math.max(0, lengths[2] ?? 0),
    color: color.join(' ') || 'rgba(0,0,0,0.5)',
  };
};

const blendModes: Record<string, string> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  difference: 'difference',
  'plus-lighter': 'lighter',
  lighter: 'lighter',
  'source-over': 'source-over',
  'destination-in': 'destination-in',
};

/** Lower a style object onto node props. Throws JSX_STYLE_* errors for anything not mapped. */
export function lowerStyle(
  style: Record<string, unknown>,
  box: StyleBox,
  at: string,
  explicit: { originX?: number; originY?: number },
): Record<string, unknown> & { zIndex?: number } {
  const out: Record<string, unknown> & { zIndex?: number } = {};
  if (!style || typeof style !== 'object' || Array.isArray(style))
    fail('JSX_STYLE_VALUE', 'style must be an object of supported keys', { at });
  const P = box.parent;
  const fontSize = () =>
    typeof style.fontSize === 'number' || typeof style.fontSize === 'string'
      ? length(style.fontSize as number | string, 16, 'fontSize', at)
      : (box.fontSize ?? 48);
  // Size first so right/bottom, origin and gradients see it.
  if (style.width !== undefined) out.width = length(style.width as never, P.width, 'width', at);
  if (style.height !== undefined)
    out.height = length(style.height as never, P.height, 'height', at);
  const self = {
    width: (out.width as number | undefined) ?? box.self.width,
    height: (out.height as number | undefined) ?? box.self.height,
  };
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    const str = typeof value === 'string' ? value : undefined;
    switch (key) {
      case 'width':
      case 'height':
        break;
      case 'position':
        if (value !== 'absolute')
          fail(
            'JSX_STYLE_UNSUPPORTED',
            `position: "${String(value)}" is not supported; every element is absolutely positioned inside its parent group`,
            { at, key },
          );
        break;
      case 'left':
        out.x = length(value as never, P.width, key, at);
        break;
      case 'top':
        out.y = length(value as never, P.height, key, at);
        break;
      case 'right':
        out.x = P.width - length(value as never, P.width, key, at) - self.width;
        break;
      case 'bottom':
        out.y = P.height - length(value as never, P.height, key, at) - self.height;
        break;
      case 'transform':
        break;
      case 'transformOrigin':
        break;
      case 'opacity':
        out.opacity = Math.max(0, Math.min(1, Number(value)));
        break;
      case 'visibility':
        out.visible = value !== 'hidden';
        break;
      case 'display':
        if (value === 'none') out.visible = false;
        else if (value !== 'block')
          fail(
            'JSX_STYLE_UNSUPPORTED',
            `display: "${String(value)}" is not supported; batch 1 has absolute positioning only (compute x/y, flex/grid planned for batch 2)`,
            { at, key },
          );
        break;
      case 'zIndex':
        out.zIndex = Number(value);
        break;
      case 'background':
      case 'backgroundColor':
      case 'backgroundImage':
      case 'fill':
      case 'color':
        if (str && /gradient\(/.test(str)) out.gradient = parseGradient(str, self, at);
        else if (key === 'backgroundImage')
          fail(
            'JSX_STYLE_UNSUPPORTED',
            'backgroundImage only accepts linear-gradient()/radial-gradient(); use <image src> for pictures',
            { at, key },
          );
        else out.fill = String(value);
        break;
      case 'stroke':
      case 'borderColor':
        out.stroke = String(value);
        break;
      case 'strokeWidth':
      case 'borderWidth':
        out.strokeWidth = length(value as never, 0, key, at);
        break;
      case 'border': {
        const words = splitSpaces(String(value));
        for (const w of words)
          if (/^-?[\d.]+(px)?$/.test(w)) out.strokeWidth = parseFloat(w);
          else if (['solid', 'none'].includes(w)) {
            if (w === 'none') out.strokeWidth = 0;
          } else if (['dashed', 'dotted'].includes(w))
            out.strokeDash = w === 'dashed' ? [8, 6] : [2, 4];
          else out.stroke = w;
        break;
      }
      case 'borderRadius':
        out.radius = length(value as never, Math.min(self.width, self.height), key, at);
        break;
      case 'boxShadow':
      case 'textShadow':
        if (value !== 'none') out.shadow = parseShadow(String(value), at);
        break;
      case 'filter': {
        if (value === 'none') break;
        const re = /([a-z-]+)\(([^)]*)\)/g;
        let m: RegExpExecArray | null,
          consumed = '';
        while ((m = re.exec(String(value)))) {
          consumed += m[0];
          const arg = m[2].trim(),
            num = arg.endsWith('%') ? parseFloat(arg) / 100 : parseFloat(arg);
          if (m[1] === 'blur') out.blur = length(arg, 0, 'blur', at);
          else if (m[1] === 'brightness') out.brightness = num;
          else if (m[1] === 'saturate') out.saturation = num;
          else if (m[1] === 'opacity') out.opacity = Math.max(0, Math.min(1, num));
          else if (m[1] === 'drop-shadow') out.shadow = parseShadow(arg, at);
          else
            fail(
              'JSX_STYLE_UNSUPPORTED',
              `filter ${m[1]}() is not mapped; supported: blur, brightness, saturate, opacity, drop-shadow. Use effects={[...]} for raster effects.`,
              { at, key },
            );
        }
        if (consumed.replace(/\s/g, '') !== String(value).replace(/\s/g, ''))
          fail('JSX_STYLE_VALUE', `filter "${String(value)}" could not be parsed`, { at, key });
        break;
      }
      case 'mixBlendMode': {
        const blend = blendModes[String(value)];
        if (!blend)
          fail(
            'JSX_STYLE_UNSUPPORTED',
            `mixBlendMode "${String(value)}" is not supported; use one of ${Object.keys(blendModes).join(', ')}`,
            { at, key },
          );
        out.blend = blend;
        break;
      }
      case 'fontSize':
        out.fontSize = fontSize();
        break;
      case 'fontFamily':
        out.fontFamily = String(value);
        break;
      case 'fontWeight': {
        const w = value === 'bold' ? 700 : value === 'normal' ? 400 : Number(value);
        if (!Number.isInteger(w) || w < 100 || w > 900)
          fail('JSX_STYLE_VALUE', 'fontWeight must be 100-900, "normal" or "bold"', { at, key });
        out.fontWeight = w;
        break;
      }
      case 'textAlign':
        if (!['left', 'center', 'right'].includes(String(value)))
          fail('JSX_STYLE_UNSUPPORTED', 'textAlign supports left, center, right', { at, key });
        out.align = value;
        break;
      case 'lineHeight':
        out.lineHeight =
          typeof value === 'number' ? value : length(value as string, 0, key, at) / fontSize();
        break;
      default: {
        const known = unsupportedStyle.find(([re]) => re.test(key));
        fail(
          'JSX_STYLE_UNSUPPORTED',
          known
            ? `style.${key} is not supported. ${known[1]}`
            : `style.${key} is not a supported style key. Supported: ${supportedStyleKeys.join(', ')}`,
          { at, key },
        );
      }
    }
  }
  const originX = explicit.originX,
    originY = explicit.originY;
  const origin =
    typeof style.transformOrigin === 'string'
      ? parseOrigin(style.transformOrigin, self, at)
      : { x: originX ?? self.width / 2, y: originY ?? self.height / 2 };
  if (typeof style.transformOrigin === 'string') {
    out.originX = origin.x;
    out.originY = origin.y;
  }
  if (typeof style.transform === 'string') {
    const t = parseTransform(style.transform, { ...box, self }, origin, at);
    if (t.matrix) out.matrix = t.matrix;
    else {
      // CSS rotate/scale pivot at the box center by default.
      if (
        (t.rotation !== undefined || t.scaleX !== undefined || t.scaleY !== undefined) &&
        typeof style.transformOrigin !== 'string' &&
        originX === undefined &&
        originY === undefined
      ) {
        out.originX = origin.x;
        out.originY = origin.y;
      }
      if (t.x) out.x = ((out.x as number | undefined) ?? 0) + t.x;
      if (t.y) out.y = ((out.y as number | undefined) ?? 0) + t.y;
      if (t.rotation !== undefined) out.rotation = t.rotation;
      if (t.scaleX !== undefined) out.scaleX = t.scaleX;
      if (t.scaleY !== undefined) out.scaleY = t.scaleY;
    }
  } else if (style.transform !== undefined)
    fail('JSX_STYLE_VALUE', 'transform must be a CSS transform string', { at, key: 'transform' });
  return out;
}

export const supportedStyleKeys = [
  'position',
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  'transform',
  'transformOrigin',
  'opacity',
  'visibility',
  'display',
  'zIndex',
  'background',
  'backgroundColor',
  'backgroundImage',
  'fill',
  'color',
  'stroke',
  'strokeWidth',
  'border',
  'borderWidth',
  'borderColor',
  'borderRadius',
  'boxShadow',
  'textShadow',
  'filter',
  'mixBlendMode',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'textAlign',
  'lineHeight',
];
/** Static suggestion for a style key, shared with the preflight linter. */
export function styleKeyProblem(key: string): string | undefined {
  if (supportedStyleKeys.includes(key)) return undefined;
  const known = unsupportedStyle.find(([re]) => re.test(key));
  return known
    ? `style.${key} is not supported. ${known[1]}`
    : `style.${key} is not a supported style key. Supported: ${supportedStyleKeys.join(', ')}`;
}
