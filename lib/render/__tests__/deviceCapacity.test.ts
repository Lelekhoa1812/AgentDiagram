import { describe, expect, it } from 'vitest';
import { getAdaptiveThresholds, RENDER_TIMEOUT_MS } from '../deviceCapacity';

describe('adaptive render budget', () => {
  it('uses the same 120s render budget for every device tier', () => {
    const low = getAdaptiveThresholds({
      cpuCores: 2,
      memoryGB: 4,
      isLowEnd: true,
      isMidRange: false,
      isHighEnd: false,
    });
    const mid = getAdaptiveThresholds({
      cpuCores: 4,
      memoryGB: 8,
      isLowEnd: false,
      isMidRange: true,
      isHighEnd: false,
    });
    const high = getAdaptiveThresholds({
      cpuCores: 8,
      memoryGB: 16,
      isLowEnd: false,
      isMidRange: false,
      isHighEnd: true,
    });

    expect(RENDER_TIMEOUT_MS).toBe(120_000);
    expect(low.renderTimeoutMs).toBe(RENDER_TIMEOUT_MS);
    expect(mid.renderTimeoutMs).toBe(RENDER_TIMEOUT_MS);
    expect(high.renderTimeoutMs).toBe(RENDER_TIMEOUT_MS);
  });
});
