import { describe, expect, it, vi } from 'vitest';
import { configureMonacoForCodeFiles } from '../monacoDefaults';

function createMonacoMock() {
  const setCompilerOptions = vi.fn();
  const setDiagnosticsOptions = vi.fn();
  const setEagerModelSync = vi.fn();

  return {
    languages: {
      typescript: {
        JsxEmit: { Preserve: 'preserve' },
        ModuleKind: { ESNext: 'esnext' },
        ModuleResolutionKind: { NodeJs: 'nodejs' },
        ScriptTarget: { ES2022: 'es2022' },
        typescriptDefaults: {
          setCompilerOptions,
          setDiagnosticsOptions,
          setEagerModelSync,
        },
        javascriptDefaults: {
          setCompilerOptions,
          setDiagnosticsOptions,
          setEagerModelSync,
        },
      },
    },
    __spies: {
      setCompilerOptions,
      setDiagnosticsOptions,
      setEagerModelSync,
    },
  };
}

describe('configureMonacoForCodeFiles', () => {
  it('configures TypeScript and JavaScript editors for repo file editing', () => {
    const monaco = createMonacoMock();

    configureMonacoForCodeFiles(monaco);

    expect(monaco.__spies.setCompilerOptions).toHaveBeenCalledTimes(2);
    expect(monaco.__spies.setDiagnosticsOptions).toHaveBeenCalledTimes(2);
    expect(monaco.__spies.setEagerModelSync).toHaveBeenCalledTimes(2);

    expect(monaco.__spies.setCompilerOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        allowJs: true,
        baseUrl: '.',
        paths: { '@/*': ['*'] },
        moduleResolution: 'nodejs',
      }),
    );
    expect(monaco.__spies.setDiagnosticsOptions).toHaveBeenCalledWith({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
  });
});
