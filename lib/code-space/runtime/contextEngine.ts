import {
  ContextGraphEngine,
  type ContextGraphOptions,
  type ContextGraphResult,
  type ContextReason,
} from './contextGraphEngine';

export type { ContextReason };
export type ContextFile = ContextGraphResult['files'][number];
export type ContextSearchResult = ContextGraphResult;

export class ContextEngine {
  constructor(private readonly graph = new ContextGraphEngine()) {}

  async collectProjectContext(
    root: string,
    prompt: string,
    openTabs: string[] = [],
    limitHint = 20,
    options: Omit<ContextGraphOptions, 'openTabs' | 'limitHint'> = {},
  ): Promise<ContextSearchResult> {
    return this.graph.collectProjectContext(root, prompt, {
      ...options,
      openTabs,
      limitHint,
    });
  }
}
