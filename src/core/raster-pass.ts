import { ImageData, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { z } from 'zod';
import type { rasterEffectSchema } from './raster-effect-schema.js';
import { applyPixelEffect } from './pixels.js';
import type { Bounds, Matrix } from './interaction.js';
export type RasterEffect = z.output<typeof rasterEffectSchema>;
export type EffectSurface = { canvas: Canvas; ctx: SKRSContext2D; release: () => void };
export type RasterEnvironment = {
  makeSurface: () => EffectSurface;
  scale: number;
  matrix: Matrix;
  offsetMatrix?: Matrix;
  bounds: Bounds;
  canvasMatrix: Matrix;
  frame: number;
  fps: number;
};
/** Shared spatial/color pass for the ordered stack and effect DAG. */
export function rasterPass(
  current: Canvas,
  effect: RasterEffect,
  env: RasterEnvironment,
): EffectSurface {
  const out = env.makeSurface();
  try {
    if (effect.type === 'glow' || effect.type === 'shadow') {
      const tint = env.makeSurface();
      try {
        tint.ctx.drawImage(current, 0, 0);
        if (effect.type === 'glow' && (effect.threshold ?? 0.55) > 0) {
          const threshold = effect.threshold ?? 0.55,
            image = tint.ctx.getImageData(0, 0, tint.canvas.width, tint.canvas.height),
            pixels = image.data;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i + 3]) {
              const brightness = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) / 255,
                weight =
                  threshold === 1
                    ? brightness === 1
                      ? 1
                      : 0
                    : Math.max(
                        0,
                        Math.min(1, ((brightness - threshold) / Math.max(0.08, 1 - threshold)) * 4),
                      );
              pixels[i + 3] = Math.round(pixels[i + 3] * weight);
            }
          tint.ctx.putImageData(image, 0, 0);
        }
        tint.ctx.globalCompositeOperation = 'source-in';
        tint.ctx.fillStyle = effect.color;
        tint.ctx.fillRect(0, 0, tint.canvas.width, tint.canvas.height);
        out.ctx.filter = `blur(${(effect.type === 'glow' ? effect.radius : effect.blur) * env.scale}px)`;
        out.ctx.globalCompositeOperation = effect.type === 'glow' ? 'screen' : 'source-over';
        const matrix = env.offsetMatrix ?? env.matrix,
          x = effect.type === 'shadow' ? matrix[0] * effect.x + matrix[2] * effect.y : 0,
          y = effect.type === 'shadow' ? matrix[1] * effect.x + matrix[3] * effect.y : 0,
          strength = effect.type === 'glow' ? effect.intensity : 1;
        for (let pass = 0; pass < Math.ceil(strength); pass++) {
          out.ctx.globalAlpha = Math.min(1, strength - pass);
          out.ctx.drawImage(tint.canvas, x, y);
        }
        out.ctx.filter = 'none';
        out.ctx.globalAlpha = 1;
        out.ctx.globalCompositeOperation = effect.type === 'glow' ? 'screen' : 'source-over';
        out.ctx.drawImage(current, 0, 0);
      } finally {
        tint.release();
      }
    } else if (effect.type === 'blur' || effect.type === 'color') {
      out.ctx.filter =
        effect.type === 'blur'
          ? `blur(${effect.radius * env.scale}px)`
          : `brightness(${effect.brightness}) contrast(${effect.contrast}) saturate(${effect.saturation}) hue-rotate(${effect.hue}deg)`;
      out.ctx.drawImage(current, 0, 0);
    } else {
      const image = current.getContext('2d').getImageData(0, 0, current.width, current.height),
        pixels = applyPixelEffect(image.data, image.width, image.height, effect, env);
      out.ctx.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
    }
    return out;
  } catch (error) {
    out.release();
    throw error;
  }
}
