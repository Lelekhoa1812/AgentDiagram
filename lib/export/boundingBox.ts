/**
 * Compute a tight bounding box around an SVG, accounting for strokes,
 * markers (arrow tips extend beyond endpoints), and group filter glows.
 */
export function svgBoundingBox(svg: SVGSVGElement): { x: number; y: number; width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  // For a rendered scene we just use the SVG's own getBBox; expand by a
  // safety margin to capture markers and drop-shadow filter regions.
  try {
    const bb = svg.getBBox();
    const margin = 16;
    return {
      x: bb.x - margin,
      y: bb.y - margin,
      width: bb.width + margin * 2,
      height: bb.height + margin * 2,
    };
  } catch {
    return { x: 0, y: 0, width: rect.width, height: rect.height };
  }
}
