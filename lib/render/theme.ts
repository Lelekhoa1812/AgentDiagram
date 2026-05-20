import type { ColorName } from '../ir/types';
import { rgba } from '../ir/colors';

export type RenderThemeMode = 'dark' | 'light';

export const RENDER_THEMES = {
  dark: {
    background: '#07090c',
    edgeStroke: 'rgba(180, 188, 204, 0.45)',
    edgeHover: 'rgba(255, 255, 255, 0.85)',
    labelFill: '#c1c7d3',
    noteFill: '#8b95a8',
    pillTextColor: '#0b0e13',
    selectionRing: 'rgba(124, 156, 255, 0.95)',
    nodeLabel: '#dde2ee',
  },
  light: {
    background: '#f4f7fb',
    edgeStroke: 'rgba(69, 82, 105, 0.62)',
    edgeHover: 'rgba(20, 28, 46, 0.86)',
    labelFill: '#475569',
    noteFill: '#64748b',
    pillTextColor: '#ffffff',
    selectionRing: 'rgba(58, 96, 229, 0.95)',
    nodeLabel: '#172033',
  },
};

export const THEME = RENDER_THEMES.dark;

export interface ColorPalette {
  groupBorder: string;
  groupFill: string;
  groupGlow: string;
  groupTitleBg: string;
  groupTitleText: string;
  nodeBorder: string;
  nodeFill: string;
  nodeIcon: string;
  nodeLabel: string;
}

export function themeFor(mode: RenderThemeMode = 'dark') {
  return RENDER_THEMES[mode];
}

export function paletteFor(color: ColorName | null, mode: RenderThemeMode = 'dark'): ColorPalette {
  const dark = mode === 'dark';
  return {
    groupBorder: rgba(color, dark ? 0.45 : 0.5),
    groupFill: rgba(color, dark ? 0.05 : 0.12),
    groupGlow: rgba(color, dark ? 0.18 : 0.08),
    groupTitleBg: rgba(color, dark ? 0.18 : 0.18),
    groupTitleText: rgba(color, 1),
    nodeBorder: rgba(color, dark ? 0.7 : 0.66),
    nodeFill: rgba(color, dark ? 0.12 : 0.17),
    nodeIcon: rgba(color, dark ? 0.95 : 0.9),
    nodeLabel: themeFor(mode).nodeLabel,
  };
}
