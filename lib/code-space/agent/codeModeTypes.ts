export interface CodeModeContextFile {
  path: string;
  content: string;
  truncated: boolean;
  score?: number;
  reasons?: string[];
}

export interface CodeModeGeneratedFile {
  path: string;
  content: string;
  reason: string;
}

export interface CodeModeGeneratedPatch {
  summary: string;
  files: CodeModeGeneratedFile[];
  assumptions: string[];
  validationNotes: string[];
  followUps: string[];
}
