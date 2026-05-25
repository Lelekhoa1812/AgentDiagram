export type RepoSourceType = 'local' | 'github';
export type RepoAuthMode = 'none' | 'pat';

export interface RepoSourceConfig {
  sourceType: RepoSourceType;
  repoPath: string;
  repoUrl?: string;
  authMode: RepoAuthMode;
  pat?: string;
}

