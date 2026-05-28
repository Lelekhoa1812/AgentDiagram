import { ValidationRunner } from './validationRunner';
import type { TerminalCommand } from './terminalPolicy';

export interface ValidationCommand {
  kind: TerminalCommand['kind'];
  command: string;
  args: string[];
}

export class ValidationManager {
  constructor(private readonly runner = new ValidationRunner()) {}

  async detectValidationCommands(rootPath: string): Promise<ValidationCommand[]> {
    const commands = await this.runner.detectValidationCommands(rootPath);
    return commands.map(({ kind, command, args }) => ({ kind, command, args }));
  }
}
