import type { ValidationRunResult } from './validationRunner';

export interface RepairAttempt {
  attempt: number;
  status: 'skipped' | 'needs_review';
  reason: string;
  failedCommands: string[];
}

export class RepairLoop {
  constructor(private readonly maxAttempts = 2) {}

  shouldRepair(results: ValidationRunResult[]): boolean {
    return results.some((result) => result.status === 'failed');
  }

  runBoundedRepair(results: ValidationRunResult[], previousAttempts: RepairAttempt[] = []): RepairAttempt {
    const failedCommands = results.filter((result) => result.status === 'failed').map((result) => result.command);
    const attempt = previousAttempts.length + 1;
    if (!failedCommands.length) {
      return { attempt, status: 'skipped', reason: 'Validation passed; no repair needed.', failedCommands: [] };
    }
    if (attempt > this.maxAttempts) {
      return {
        attempt,
        status: 'needs_review',
        reason: 'Repair retry budget exhausted.',
        failedCommands,
      };
    }
    return {
      attempt,
      status: 'needs_review',
      reason: 'Validation failed and requires a targeted repair patch before verification.',
      failedCommands,
    };
  }
}
