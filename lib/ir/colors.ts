import type { ColorName } from './types';

interface ColorTokens {
  /** Border / stroke base color (rgb) */
  base: [number, number, number];
}

const BASE: Record<ColorName, [number, number, number]> = {
  orange: [255, 154, 60],
  green: [86, 196, 132],
  yellow: [232, 209, 80],
  amber: [240, 180, 60],
  coral: [240, 116, 96],
  teal: [80, 200, 192],
  cyan: [34, 211, 238],
  mint: [110, 231, 183],
  emerald: [52, 211, 153],
  slate: [148, 163, 184],
  zinc: [161, 161, 170],
  stone: [168, 162, 158],
  neutral: [163, 163, 163],
  white: [241, 245, 249],
  indigo: [129, 140, 248],
  blue: [96, 165, 250],
  purple: [180, 120, 240],
  violet: [167, 139, 250],
  fuchsia: [232, 121, 249],
  lime: [144, 220, 96],
  sky: [120, 196, 240],
  red: [240, 90, 90],
  rose: [251, 113, 133],
  pink: [240, 130, 180],
  gray: [156, 163, 175],
};

export function colorTokens(name: ColorName | null | undefined): ColorTokens {
  if (!name) return { base: [156, 163, 175] };
  return { base: BASE[name] };
}

export function rgba(name: ColorName | null | undefined, alpha: number): string {
  const [r, g, b] = colorTokens(name).base;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function hex(name: ColorName | null | undefined): string {
  const [r, g, b] = colorTokens(name).base;
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
