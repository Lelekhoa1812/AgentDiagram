/**
 * Inline SVG icon registry — Lucide-style 24x24 path data.
 * Each entry returns an SVG <path>-ready `d` attribute string.
 *
 * Renderer uses these with stroke="currentColor" and a transform that
 * scales them down to the desired rendering size.
 */

export interface IconDef {
  /** Multiple path or shape elements (each is a self-contained SVG element string). */
  paths: string[];
  /** Viewbox is always 24 24. */
  viewBox: '0 0 24 24';
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const REG: Record<string, IconDef> = {
  file: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>',
      '<polyline points="14 2 14 8 20 8"/>',
    ],
  },
  'file-text': {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>',
      '<polyline points="14 2 14 8 20 8"/>',
      '<line x1="8" y1="13" x2="16" y2="13"/>',
      '<line x1="8" y1="17" x2="16" y2="17"/>',
      '<line x1="8" y1="9" x2="10" y2="9"/>',
    ],
  },
  'file-spreadsheet': {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>',
      '<polyline points="14 2 14 8 20 8"/>',
      '<line x1="8" y1="13" x2="16" y2="13"/>',
      '<line x1="8" y1="17" x2="16" y2="17"/>',
      '<line x1="12" y1="11" x2="12" y2="19"/>',
    ],
  },
  'file-code': {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>',
      '<polyline points="14 2 14 8 20 8"/>',
      '<polyline points="10 13 8 15 10 17"/>',
      '<polyline points="14 13 16 15 14 17"/>',
    ],
  },
  folder: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    ],
  },
  archive: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="2" y="3" width="20" height="5"/>',
      '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>',
      '<line x1="10" y1="12" x2="14" y2="12"/>',
    ],
  },
  clock: {
    viewBox: '0 0 24 24',
    paths: [
      '<circle cx="12" cy="12" r="10"/>',
      '<polyline points="12 6 12 12 16 14"/>',
    ],
  },
  'check-square': {
    viewBox: '0 0 24 24',
    paths: [
      '<polyline points="9 11 12 14 22 4"/>',
      '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    ],
  },
  'check-circle': {
    viewBox: '0 0 24 24',
    paths: ['<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>', '<polyline points="22 4 12 14.01 9 11.01"/>'],
  },
  cpu: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="4" y="4" width="16" height="16" rx="2"/>',
      '<rect x="9" y="9" width="6" height="6"/>',
      '<line x1="9" y1="2" x2="9" y2="4"/>',
      '<line x1="15" y1="2" x2="15" y2="4"/>',
      '<line x1="9" y1="20" x2="9" y2="22"/>',
      '<line x1="15" y1="20" x2="15" y2="22"/>',
      '<line x1="20" y1="9" x2="22" y2="9"/>',
      '<line x1="20" y1="15" x2="22" y2="15"/>',
      '<line x1="2" y1="9" x2="4" y2="9"/>',
      '<line x1="2" y1="15" x2="4" y2="15"/>',
    ],
  },
  scan: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M3 7V5a2 2 0 0 1 2-2h2"/>',
      '<path d="M17 3h2a2 2 0 0 1 2 2v2"/>',
      '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/>',
      '<path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
      '<line x1="7" y1="12" x2="17" y2="12"/>',
    ],
  },
  tool: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'],
  },
  filter: {
    viewBox: '0 0 24 24',
    paths: ['<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'],
  },
  'git-branch': {
    viewBox: '0 0 24 24',
    paths: [
      '<line x1="6" y1="3" x2="6" y2="15"/>',
      '<circle cx="18" cy="6" r="3"/>',
      '<circle cx="6" cy="18" r="3"/>',
      '<path d="M18 9a9 9 0 0 1-9 9"/>',
    ],
  },
  workflow: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="3" y="3" width="6" height="6"/>',
      '<rect x="15" y="15" width="6" height="6"/>',
      '<path d="M9 6h6a3 3 0 0 1 3 3v6"/>',
    ],
  },
  search: {
    viewBox: '0 0 24 24',
    paths: ['<circle cx="11" cy="11" r="8"/>', '<line x1="21" y1="21" x2="16.65" y2="16.65"/>'],
  },
  sparkles: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/>',
      '<path d="M19 14l.8 2.4L22 17l-2.2.6L19 20l-.8-2.4L16 17l2.2-.6z"/>',
      '<path d="M5 14l.8 2.4L8 17l-2.2.6L5 20l-.8-2.4L2 17l2.2-.6z"/>',
    ],
  },
  'refresh-cw': {
    viewBox: '0 0 24 24',
    paths: [
      '<polyline points="23 4 23 10 17 10"/>',
      '<polyline points="1 20 1 14 7 14"/>',
      '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    ],
  },
  tableau: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="3" y="3" width="18" height="18" rx="2"/>',
      '<line x1="3" y1="9" x2="21" y2="9"/>',
      '<line x1="3" y1="15" x2="21" y2="15"/>',
      '<line x1="9" y1="3" x2="9" y2="21"/>',
      '<line x1="15" y1="3" x2="15" y2="21"/>',
    ],
  },
  shield: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'],
  },
  scale: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M12 3v18"/>',
      '<path d="M6 12L3 21h6z"/>',
      '<path d="M18 12l-3 9h6z"/>',
      '<line x1="3" y1="3" x2="21" y2="3"/>',
    ],
  },
  'book-open': {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>',
      '<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    ],
  },
  activity: {
    viewBox: '0 0 24 24',
    paths: ['<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'],
  },
  columns: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7M12 3v18"/>'],
  },
  table: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="3" y="3" width="18" height="18" rx="2"/>',
      '<line x1="3" y1="9" x2="21" y2="9"/>',
      '<line x1="3" y1="15" x2="21" y2="15"/>',
      '<line x1="12" y1="3" x2="12" y2="21"/>',
    ],
  },
  edit: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>',
      '<polygon points="18.5 2.5 22 6 12 16 8 16 8 12 18.5 2.5"/>',
    ],
  },
  'help-circle': {
    viewBox: '0 0 24 24',
    paths: [
      '<circle cx="12" cy="12" r="10"/>',
      '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>',
      '<line x1="12" y1="17" x2="12.01" y2="17"/>',
    ],
  },
  list: {
    viewBox: '0 0 24 24',
    paths: [
      '<line x1="8" y1="6" x2="21" y2="6"/>',
      '<line x1="8" y1="12" x2="21" y2="12"/>',
      '<line x1="8" y1="18" x2="21" y2="18"/>',
      '<line x1="3" y1="6" x2="3.01" y2="6"/>',
      '<line x1="3" y1="12" x2="3.01" y2="12"/>',
      '<line x1="3" y1="18" x2="3.01" y2="18"/>',
    ],
  },
  'message-square': {
    viewBox: '0 0 24 24',
    paths: ['<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'],
  },
  'message-circle': {
    viewBox: '0 0 24 24',
    paths: ['<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'],
  },
  plug: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M9 2v6"/>',
      '<path d="M15 2v6"/>',
      '<path d="M5 8h14v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5z"/>',
      '<path d="M12 16v6"/>',
    ],
  },
  'dollar-sign': {
    viewBox: '0 0 24 24',
    paths: [
      '<line x1="12" y1="1" x2="12" y2="23"/>',
      '<path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    ],
  },
  package: {
    viewBox: '0 0 24 24',
    paths: [
      '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/>',
      '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
      '<polyline points="3.27 6.96 12 12.01 20.73 6.96"/>',
      '<line x1="12" y1="22.08" x2="12" y2="12"/>',
    ],
  },
  monitor: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="2" y="3" width="20" height="14" rx="2"/>',
      '<line x1="8" y1="21" x2="16" y2="21"/>',
      '<line x1="12" y1="17" x2="12" y2="21"/>',
    ],
  },
  server: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="2" y="3" width="20" height="8" rx="2"/>',
      '<rect x="2" y="13" width="20" height="8" rx="2"/>',
      '<line x1="6" y1="7" x2="6" y2="7"/>',
      '<line x1="6" y1="17" x2="6" y2="17"/>',
    ],
  },
  briefcase: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="2" y="7" width="20" height="14" rx="2"/>',
      '<path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    ],
  },
  download: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
      '<polyline points="7 10 12 15 17 10"/>',
      '<line x1="12" y1="15" x2="12" y2="3"/>',
    ],
  },
  'hard-drive': {
    viewBox: '0 0 24 24',
    paths: [
      '<line x1="22" y1="12" x2="2" y2="12"/>',
      '<path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
      '<line x1="6" y1="16" x2="6.01" y2="16"/>',
    ],
  },
  brain: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M12 2a5 5 0 0 0-5 5v0a3 3 0 0 0-3 3v3a3 3 0 0 0 3 3v0a5 5 0 0 0 5 5 5 5 0 0 0 5-5v0a3 3 0 0 0 3-3v-3a3 3 0 0 0-3-3v0a5 5 0 0 0-5-5z"/>'],
  },
  eye: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>',
      '<circle cx="12" cy="12" r="3"/>',
    ],
  },
  pencil: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M12 20h9"/>', '<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>'],
  },
  presentation: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M2 3h20"/>',
      '<path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/>',
      '<path d="M7 21l5-5 5 5"/>',
    ],
  },
  type: {
    viewBox: '0 0 24 24',
    paths: ['<polyline points="4 7 4 4 20 4 20 7"/>', '<line x1="9" y1="20" x2="15" y2="20"/>', '<line x1="12" y1="4" x2="12" y2="20"/>'],
  },
  layout: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="3" y="3" width="18" height="18" rx="2"/>',
      '<line x1="3" y1="9" x2="21" y2="9"/>',
      '<line x1="9" y1="21" x2="9" y2="9"/>',
    ],
  },
  code: {
    viewBox: '0 0 24 24',
    paths: ['<polyline points="16 18 22 12 16 6"/>', '<polyline points="8 6 2 12 8 18"/>'],
  },
  tag: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>',
      '<line x1="7" y1="7" x2="7.01" y2="7"/>',
    ],
  },
  settings: {
    viewBox: '0 0 24 24',
    paths: [
      '<circle cx="12" cy="12" r="3"/>',
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    ],
  },
  database: {
    viewBox: '0 0 24 24',
    paths: [
      '<ellipse cx="12" cy="5" rx="9" ry="3"/>',
      '<path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>',
      '<path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>',
    ],
  },
  cloud: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M17.5 19H8a6 6 0 1 1 1.2-11.88A7 7 0 0 1 22 12.5 4.5 4.5 0 0 1 17.5 19z"/>'],
  },
  'cloud-upload': {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M16 16l-4-4-4 4"/>',
      '<path d="M12 12v9"/>',
      '<path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>',
    ],
  },
  globe: {
    viewBox: '0 0 24 24',
    paths: [
      '<circle cx="12" cy="12" r="10"/>',
      '<path d="M2 12h20"/>',
      '<path d="M12 2a15.3 15.3 0 0 1 0 20"/>',
      '<path d="M12 2a15.3 15.3 0 0 0 0 20"/>',
    ],
  },
  lock: {
    viewBox: '0 0 24 24',
    paths: ['<rect x="3" y="11" width="18" height="11" rx="2"/>', '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>'],
  },
  key: {
    viewBox: '0 0 24 24',
    paths: ['<circle cx="7.5" cy="15.5" r="5.5"/>', '<path d="M12 12l9-9"/>', '<path d="M16 8l3 3"/>', '<path d="M14 10l2 2"/>'],
  },
  users: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>',
      '<circle cx="9" cy="7" r="4"/>',
      '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
      '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    ],
  },
  user: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>', '<circle cx="12" cy="7" r="4"/>'],
  },
  smartphone: {
    viewBox: '0 0 24 24',
    paths: ['<rect x="5" y="2" width="14" height="20" rx="2"/>', '<line x1="12" y1="18" x2="12.01" y2="18"/>'],
  },
  terminal: {
    viewBox: '0 0 24 24',
    paths: ['<polyline points="4 17 10 11 4 5"/>', '<line x1="12" y1="19" x2="20" y2="19"/>'],
  },
  layers: {
    viewBox: '0 0 24 24',
    paths: [
      '<polygon points="12 2 2 7 12 12 22 7 12 2"/>',
      '<polyline points="2 17 12 22 22 17"/>',
      '<polyline points="2 12 12 17 22 12"/>',
    ],
  },
  network: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="16" y="16" width="6" height="6" rx="1"/>',
      '<rect x="2" y="16" width="6" height="6" rx="1"/>',
      '<rect x="9" y="2" width="6" height="6" rx="1"/>',
      '<path d="M12 8v4"/>',
      '<path d="M5 16v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/>',
    ],
  },
  router: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="3" y="13" width="18" height="8" rx="2"/>',
      '<path d="M7 17h.01"/>',
      '<path d="M11 17h.01"/>',
      '<path d="M15 17h2"/>',
      '<path d="M8 13V9"/>',
      '<path d="M16 13V9"/>',
      '<path d="M12 5a8 8 0 0 1 5.66 2.34"/>',
      '<path d="M6.34 7.34A8 8 0 0 1 12 5"/>',
    ],
  },
  webhook: {
    viewBox: '0 0 24 24',
    paths: [
      '<path d="M18 16.98h-5.99c-1.1 0-2-.9-2-2v-1.96"/>',
      '<path d="M6 7.02h5.99c1.1 0 2 .9 2 2v1.96"/>',
      '<circle cx="6" cy="7" r="3"/>',
      '<circle cx="18" cy="17" r="3"/>',
      '<circle cx="12" cy="12" r="3"/>',
    ],
  },
  bot: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="3" y="11" width="18" height="10" rx="2"/>',
      '<circle cx="8" cy="16" r="1"/>',
      '<circle cx="16" cy="16" r="1"/>',
      '<path d="M12 11V7"/>',
      '<circle cx="12" cy="4" r="2"/>',
    ],
  },
  zap: {
    viewBox: '0 0 24 24',
    paths: ['<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'],
  },
  bell: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/>', '<path d="M13.73 21a2 2 0 0 1-3.46 0"/>'],
  },
  mail: {
    viewBox: '0 0 24 24',
    paths: ['<rect x="2" y="4" width="20" height="16" rx="2"/>', '<polyline points="22 6 12 13 2 6"/>'],
  },
  calendar: {
    viewBox: '0 0 24 24',
    paths: ['<rect x="3" y="4" width="18" height="18" rx="2"/>', '<line x1="16" y1="2" x2="16" y2="6"/>', '<line x1="8" y1="2" x2="8" y2="6"/>', '<line x1="3" y1="10" x2="21" y2="10"/>'],
  },
  'credit-card': {
    viewBox: '0 0 24 24',
    paths: ['<rect x="2" y="5" width="20" height="14" rx="2"/>', '<line x1="2" y1="10" x2="22" y2="10"/>'],
  },
  'bar-chart-3': {
    viewBox: '0 0 24 24',
    paths: ['<path d="M3 3v18h18"/>', '<rect x="7" y="12" width="3" height="5"/>', '<rect x="12" y="8" width="3" height="9"/>', '<rect x="17" y="5" width="3" height="12"/>'],
  },
  'line-chart': {
    viewBox: '0 0 24 24',
    paths: ['<path d="M3 3v18h18"/>', '<path d="M7 16l4-5 4 3 5-8"/>'],
  },
  'trending-up': {
    viewBox: '0 0 24 24',
    paths: ['<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>', '<polyline points="17 6 23 6 23 12"/>'],
  },
  bug: {
    viewBox: '0 0 24 24',
    paths: [
      '<rect x="8" y="6" width="8" height="14" rx="4"/>',
      '<path d="M19 7l-3 2"/>',
      '<path d="M5 7l3 2"/>',
      '<path d="M19 19l-3-2"/>',
      '<path d="M5 19l3-2"/>',
      '<path d="M20 13h-4"/>',
      '<path d="M4 13h4"/>',
      '<path d="M10 4l1 2"/>',
      '<path d="M14 4l-1 2"/>',
    ],
  },
  flask: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M9 3h6"/>', '<path d="M10 3v6l-5 9a3 3 0 0 0 2.6 4h8.8A3 3 0 0 0 19 18l-5-9V3"/>', '<path d="M8 15h8"/>'],
  },
  rocket: {
    viewBox: '0 0 24 24',
    paths: ['<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>', '<path d="M9 15l-1.5-1.5A16 16 0 0 1 21 3a16 16 0 0 1-10.5 13.5L9 15z"/>', '<path d="M15 9h.01"/>'],
  },
  circle: {
    viewBox: '0 0 24 24',
    paths: ['<circle cx="12" cy="12" r="10"/>'],
  },
};
/* eslint-enable */

export function getIcon(name: string | null | undefined): IconDef {
  if (!name) return REG.circle!;
  const def = REG[name];
  return def ?? REG.circle!;
}

export function knownIconNames(): string[] {
  return Object.keys(REG);
}
