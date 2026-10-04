import type { Keyframe, Node, Project } from './model.js';
export const frameSeconds = (frame: number, fps: Project['fps']) => (frame * fps.den) / fps.num;
export const frameSample = (frame: number, fps: Project['fps'], sampleRate = 48000) =>
  Number((BigInt(Math.trunc(frame)) * BigInt(fps.den) * BigInt(sampleRate)) / BigInt(fps.num));
export function ease(t: number, easing: Keyframe['easing']) {
  if (easing === 'hold') return t >= 1 ? 1 : 0;
  if (easing === 'easeIn') return t * t * t;
  if (easing === 'easeOut') return 1 - (1 - t) ** 3;
  if (easing === 'easeInOut') return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
  if (easing === 'spring') return t === 0 || t === 1 ? t : 1 - Math.exp(-7 * t) * Math.cos(12 * t);
  return t;
}
export function interpolate(keys: Keyframe[], frame: number): number {
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  if (frame <= sorted[0].frame) return sorted[0].value;
  for (let i = 1; i < sorted.length; i++)
    if (frame < sorted[i].frame) {
      const a = sorted[i - 1],
        b = sorted[i];
      return (
        a.value +
        (b.value - a.value) *
          (a.easing === 'bezier'
            ? bezierEase((frame - a.frame) / (b.frame - a.frame), a.bezier ?? [0.25, 0.1, 0.25, 1])
            : ease((frame - a.frame) / (b.frame - a.frame), a.easing))
      );
    }
  return sorted.at(-1)!.value;
}
export function evaluateNode(node: Node, frame: number): Node {
  const result = node.animations.length ? structuredClone(node) : { ...node };
  for (const animation of node.animations)
    setNumericPath(result, animation.property, interpolate(animation.keys, frame));
  result.opacity = Math.min(1, Math.max(0, result.opacity));
  result.reveal = Math.min(1, Math.max(0, result.reveal));
  return result;
}
export function bezierEase(t: number, control: [number, number, number, number]) {
  const curve = (q: number, a: number, b: number) =>
    3 * (1 - q) ** 2 * q * a + 3 * (1 - q) * q * q * b + q * q * q;
  let low = 0,
    high = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (low + high) / 2;
    if (curve(mid, control[0], control[2]) < t) low = mid;
    else high = mid;
  }
  return t <= 0 ? 0 : t >= 1 ? 1 : curve((low + high) / 2, control[1], control[3]);
}
export function getNumericPath(value: unknown, property: string): number {
  let current: any = value;
  for (const part of property.split('.')) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(part) ||
      current === null ||
      typeof current !== 'object'
    )
      throw new Error(`Invalid animation path ${property}`);
    current = current[part];
  }
  if (typeof current !== 'number' || !Number.isFinite(current))
    throw new Error(`Animation target ${property} is not numeric`);
  return current;
}
export function setNumericPath(value: unknown, property: string, number: number) {
  if (!Number.isFinite(number)) throw new Error(`Animation value for ${property} is not finite`);
  getNumericPath(value, property);
  const parts = property.split('.');
  let current: any = value;
  for (const part of parts.slice(0, -1)) current = current[part];
  current[parts.at(-1)!] = number;
}
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
