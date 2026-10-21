// Colour helpers: sRGB mixing and WCAG 2.x contrast.
import { hexToRgb } from './raster.mjs';

export { hexToRgb };

export const rgbToHex = (rgb) => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// Mix `amount` of `b` into `a` in sRGB, matching CSS color-mix(in srgb, b amount, a).
export function mix(a, b, amount) {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  return rgbToHex(ra.map((v, i) => v + (rb[i] - v) * amount));
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
