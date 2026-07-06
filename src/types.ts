export interface RuntimeInfo {
  name: string;
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface ProjectInfo {
  path: string;
  name: string;
  type: 'nodejs' | 'python' | 'java' | 'go' | 'docker' | 'unknown';
  mainFiles: string[];
  lastModified: string;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MCPServersAudit {
  configPath: string;
  servers: Record<string, MCPServerConfig>;
}

export interface DriftWarning {
  projectPath: string;
  type: 'duplicate' | 'stale' | 'version_mismatch' | 'unused';
  message: string;
  severity: 'low' | 'medium' | 'high';
}

export interface EncodingAuditResult {
  filePath: string;
  encoding: string;
  hasBOM: boolean;
  hasMojibake: boolean;
  issues: string[];
}

export interface SecurityFinding {
  id: string;
  severity: 'low' | 'medium' | 'high';
  filePath: string;
  line?: number;
  message: string;
  recommendation: string;
}

export interface SecurityPostureReport {
  workspaceRoot: string;
  score: number;
  findings: SecurityFinding[];
  summary: {
    high: number;
    medium: number;
    low: number;
  };
}
