import type { ClipLayout, FaceCam } from "../../../shared/types.js";

export const OUT_W = 1080;
export const OUT_H = 1920;
export const OUT_FPS = 30;

/** A rectangle in source pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One piece of the output: a crop of the source, scaled and placed on the 1080×1920 canvas. */
export interface Panel {
  crop: Box;
  /** Size and top-left position on the canvas. */
  out: Box;
  blur: boolean;
}

export interface LayoutPlan {
  layout: ClipLayout;
  /** Drawn in order; later panels go on top. */
  panels: Panel[];
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** The largest crop of the given aspect (w/h) that fits the source, centred on (cx, cy). */
export function cropToAspect(srcW: number, srcH: number, aspect: number, cx = srcW / 2, cy = srcH / 2, within?: Box): Box {
  const area = within ?? { x: 0, y: 0, w: srcW, h: srcH };
  let w = area.w;
  let h = w / aspect;
  if (h > area.h) {
    h = area.h;
    w = h * aspect;
  }
  w = Math.min(even(w), even(area.w));
  h = Math.min(even(h), even(area.h));
  const x = Math.round(Math.min(Math.max(cx - w / 2, area.x), area.x + area.w - w));
  const y = Math.round(Math.min(Math.max(cy - h / 2, area.y), area.y + area.h - h));
  return { x, y, w, h };
}

/** Converts a face cam rectangle (fractions of the frame) to source pixels, kept inside the frame. */
export function rectToBox(r: FaceCam, srcW: number, srcH: number): Box {
  const x = Math.max(0, Math.min(srcW - 2, Math.round(r.x * srcW)));
  const y = Math.max(0, Math.min(srcH - 2, Math.round(r.y * srcH)));
  return { x, y, w: Math.min(even(r.w * srcW), even(srcW - x)), h: Math.min(even(r.h * srcH), even(srcH - y)) };
}

/**
 * Crop and scale math for each layout on a 1080×1920 canvas:
 * - stacked: the face cam on top (its height follows the face cam's shape, 1/4 to 1/2 of the
 *   canvas), the gameplay centre crop below. Needs a face cam rectangle.
 * - center: a 9:16 centre crop of the gameplay.
 * - full: the whole frame, fitted to the width, over a blurred centre crop of itself.
 */
export function planLayout(layout: ClipLayout, srcW: number, srcH: number, faceCam: FaceCam | null = null): LayoutPlan {
  if (!(srcW >= 2 && srcH >= 2)) throw new Error(`The video has no usable size (${srcW}×${srcH}).`);
  const canvas: Box = { x: 0, y: 0, w: OUT_W, h: OUT_H };

  if (layout === "stacked" && faceCam) {
    const face = rectToBox(faceCam, srcW, srcH);
    const topH = even(Math.min(OUT_H / 2, Math.max(OUT_H / 4, (OUT_W * face.h) / face.w)));
    const faceCrop = cropToAspect(srcW, srcH, OUT_W / topH, face.x + face.w / 2, face.y + face.h / 2, face);
    const bottomH = OUT_H - topH;
    return {
      layout: "stacked",
      panels: [
        { crop: faceCrop, out: { x: 0, y: 0, w: OUT_W, h: topH }, blur: false },
        { crop: cropToAspect(srcW, srcH, OUT_W / bottomH), out: { x: 0, y: topH, w: OUT_W, h: bottomH }, blur: false },
      ],
    };
  }

  const center = cropToAspect(srcW, srcH, OUT_W / OUT_H);
  if (layout === "full") {
    let fitW = OUT_W;
    let fitH = even((OUT_W * srcH) / srcW);
    if (fitH > OUT_H) {
      fitH = OUT_H;
      fitW = even((OUT_H * srcW) / srcH);
    }
    return {
      layout: "full",
      panels: [
        { crop: center, out: canvas, blur: true },
        {
          crop: { x: 0, y: 0, w: even(srcW), h: even(srcH) },
          out: { x: Math.floor((OUT_W - fitW) / 2), y: Math.floor((OUT_H - fitH) / 2), w: fitW, h: fitH },
          blur: false,
        },
      ],
    };
  }
  return { layout: "center", panels: [{ crop: center, out: canvas, blur: false }] };
}

/**
 * The ffmpeg filter graph for a plan: each panel cropped, scaled (and blurred) from the input,
 * laid onto a black 1080×1920 canvas, then the ASS captions burned in. Output label [v].
 */
export function videoFilter(plan: LayoutPlan, assFile: string | null): string {
  const n = plan.panels.length;
  const parts = [`[0:v]fps=${OUT_FPS},split=${n}${plan.panels.map((_, i) => `[s${i}]`).join("")}`];
  plan.panels.forEach((p, i) => {
    const blur = p.blur ? ",boxblur=luma_radius=40:luma_power=2" : "";
    parts.push(
      `[s${i}]crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y},scale=${p.out.w}:${p.out.h},setsar=1${blur}[p${i}]`,
    );
  });
  parts.push(`color=c=black:s=${OUT_W}x${OUT_H}:r=${OUT_FPS}[c0]`);
  plan.panels.forEach((p, i) => {
    parts.push(`[c${i}][p${i}]overlay=${p.out.x}:${p.out.y}:shortest=1[c${i + 1}]`);
  });
  const subs = assFile ? `ass=${assFile},` : "";
  parts.push(`[c${n}]${subs}format=yuv420p[v]`);
  return parts.join(";");
}
