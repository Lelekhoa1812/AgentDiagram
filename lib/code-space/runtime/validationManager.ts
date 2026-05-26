import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ValidationCommand {
  kind: 'syntax' | 'format' | 'test' | 'typecheck' | 'lint' | 'build';
  command: string;
  args: string[];
}

export class ValidationManager {
  async detectValidationCommands(rootPath: string): Promise<ValidationCommand[]> {
    const packageJsonPath = path.join(rootPath, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { scripts?: Record<string, string>; packageManager?: string };
      const packageManager = await detectPackageManager(rootPath, pkg.packageManager);
      const scripts = pkg.scripts ?? {};
      const commands: ValidationCommand[] = [];
      if (scripts.test) commands.push({ kind: 'test', command: packageManager, args: ['run', 'test'] });
      if (scripts.typecheck) commands.push({ kind: 'typecheck', command: packageManager, args: ['run', 'typecheck'] });
      if (scripts.lint) commands.push({ kind: 'lint', command: packageManager, args: ['run', 'lint'] });
      if (scripts.build) commands.push({ kind: 'build', command: packageManager, args: ['run', 'build'] });
      return commands;
    } catch {
      return [];
    }
  }
}

async function detectPackageManager(rootPath: string, packageManager?: string): Promise<string> {
  if (packageManager?.startsWith('pnpm')) return 'pnpm';
  if (packageManager?.startsWith('yarn')) return 'yarn';
  if (packageManager?.startsWith('bun')) return 'bun';
  if (await exists(path.join(rootPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(rootPath, 'yarn.lock'))) return 'yarn';
  if (await exists(path.join(rootPath, 'bun.lockb'))) return 'bun';
  return 'npm';
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

