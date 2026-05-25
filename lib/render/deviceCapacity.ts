/**
 * Device Capacity Detection
 *
 * Detects runtime device capabilities (CPU cores, RAM) and returns adaptive
 * thresholds for layout complexity, edge routing, and timeouts. Enables the
 * rendering system to degrade gracefully on low-end devices while taking
 * full advantage of high-end hardware.
 */

export interface DeviceCapacity {
  cpuCores: number;
  memoryGB: number;
  isLowEnd: boolean;
  isMidRange: boolean;
  isHighEnd: boolean;
}

export const RENDER_TIMEOUT_MS = 120_000;

export interface AdaptiveThresholds {
  complexityLimit: number;
  edgeLimit: number;
  routingFastRouteThreshold: number;
  layoutTimeoutMs: number;
  renderTimeoutMs: number;
  forceDirectedIterations: number;
  renderElementLimit: number;
  renderPixelLimit: number;
}

/**
 * Detect device capabilities using standard browser APIs.
 * Gracefully defaults to mid-range specs if APIs unavailable.
 */
export function detectDeviceCapacity(): DeviceCapacity {
  // CPU cores: navigator.hardwareConcurrency (supported in most modern browsers)
  // Default to 4 if unavailable
  const cpuCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;

  // Memory: navigator.deviceMemory (supported in Chromium, not Safari/Firefox)
  // Default to 8GB if unavailable. This is an estimate and may not be accurate.
  const memoryGB =
    typeof navigator !== 'undefined'
      ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8)
      : 8;

  // Classify device based on specs
  // Low-end: <= 2 cores AND <= 4GB memory
  // High-end: >= 8 cores OR >= 16GB memory
  // Mid-range: everything else
  const isLowEnd = cpuCores <= 2 && memoryGB <= 4;
  const isHighEnd = cpuCores >= 8 || memoryGB >= 16;
  const isMidRange = !isLowEnd && !isHighEnd;

  return {
    cpuCores,
    memoryGB,
    isLowEnd,
    isMidRange,
    isHighEnd,
  };
}

/**
 * Get adaptive thresholds based on device capacity.
 * Scales complexity limits, routing thresholds, and timeouts appropriately.
 */
export function getAdaptiveThresholds(device: DeviceCapacity): AdaptiveThresholds {
  if (device.isLowEnd) {
    return {
      // Conservative limits for low-end devices
      // Reduce cross-group edge complexity limit to force bundling earlier
      complexityLimit: 100,
      edgeLimit: 60,
      // Switch to fast routing much earlier
      routingFastRouteThreshold: 40,
      // Shorter timeout (5s) but still reasonable for layout to complete
      layoutTimeoutMs: 5_000,
      renderTimeoutMs: RENDER_TIMEOUT_MS,
      // Fewer force-directed iterations (faster convergence)
      forceDirectedIterations: 50,
      renderElementLimit: 450,
      renderPixelLimit: 24_000_000,
    };
  }

  if (device.isHighEnd) {
    return {
      // Aggressive limits for high-end devices
      // Can handle more cross-group edges due to better CPU/memory
      complexityLimit: 300,
      edgeLimit: 200,
      // Delay fast routing threshold to allow more A* routing
      routingFastRouteThreshold: 120,
      // Longer timeout (15s) allows complex layouts to complete
      layoutTimeoutMs: 15_000,
      renderTimeoutMs: RENDER_TIMEOUT_MS,
      // More force-directed iterations for better convergence
      forceDirectedIterations: 200,
      renderElementLimit: 1_600,
      renderPixelLimit: 120_000_000,
    };
  }

  // Mid-range (default balanced thresholds)
  return {
    complexityLimit: 200,
    edgeLimit: 120,
    routingFastRouteThreshold: 80,
    layoutTimeoutMs: 10_000,
    renderTimeoutMs: RENDER_TIMEOUT_MS,
    forceDirectedIterations: 100,
    renderElementLimit: 900,
    renderPixelLimit: 60_000_000,
  };
}

/**
 * Get a human-readable description of device class.
 * Useful for logging and diagnostics.
 */
export function describeDeviceCapacity(device: DeviceCapacity): string {
  let category = 'mid-range';
  if (device.isLowEnd) category = 'low-end';
  if (device.isHighEnd) category = 'high-end';

  return `${category} device (${device.cpuCores} cores, ${device.memoryGB}GB RAM)`;
}
