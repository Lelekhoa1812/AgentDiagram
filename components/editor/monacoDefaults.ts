'use client';

// Motivation vs Logic: Code Space edits arbitrary repo files in a browser-only Monaco instance, so we need sane
// TypeScript/JavaScript defaults that preserve editing support without surfacing false project-wide diagnostics that
// Monaco cannot resolve from the workspace filesystem.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Monaco = any;

export function configureMonacoForCodeFiles(monaco: Monaco) {
  const ts = monaco.languages?.typescript;
  if (!ts) return;

  const sharedCompilerOptions = {
    allowJs: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    isolatedModules: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    noEmit: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    baseUrl: '.',
    paths: {
      '@/*': ['*'],
    },
  };

  ts.typescriptDefaults.setCompilerOptions({
    ...sharedCompilerOptions,
    checkJs: false,
  });
  ts.javascriptDefaults.setCompilerOptions({
    ...sharedCompilerOptions,
    checkJs: false,
  });

  // Keep syntax validation on, but stop Monaco from reporting semantic import resolution errors for files it cannot
  // fully model without a synced project graph.
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });

  ts.typescriptDefaults.setEagerModelSync?.(true);
  ts.javascriptDefaults.setEagerModelSync?.(true);
}
