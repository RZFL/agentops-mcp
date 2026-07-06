import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface AgentComponentFinding {
  host: string;
  name: string;
  kind: string;
  status: string;
  risk: 'low' | 'medium' | 'high' | string;
  path?: string;
  evidence?: string;
  instruction?: string;
}

export interface AgentComponentInspectionOptions {
  extraRoots?: string[];
  maxFindings?: number;
  includeInstructions?: boolean;
  useCache?: boolean;
  cacheTtlMs?: number;
}

export interface AgentComponentInspectionReport {
  inspector: string;
  mode: 'read-only';
  cached: boolean;
  findingCount: number;
  returnedCount: number;
  truncated: boolean;
  summary: Record<string, number>;
  findings: AgentComponentFinding[];
}

interface InspectorCacheEntry {
  key: string;
  createdAt: number;
  findings: AgentComponentFinding[];
}

const DEFAULT_CACHE_TTL_MS = 30000;
let inspectorCache: InspectorCacheEntry | undefined;

function getInspectorScriptPath(): string {
  return path.resolve(__dirname, '..', '..', 'inspector', 'agent_component_inspector.py');
}

function normalizeLimit(maxFindings?: number): number {
  if (!Number.isFinite(maxFindings)) {
    return 50;
  }

  return Math.min(Math.max(Math.floor(maxFindings as number), 1), 200);
}

function normalizeCacheTtl(cacheTtlMs?: number): number {
  if (!Number.isFinite(cacheTtlMs)) {
    return DEFAULT_CACHE_TTL_MS;
  }

  return Math.min(Math.max(Math.floor(cacheTtlMs as number), 0), 300000);
}

function assertSafeRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);

  if (!path.isAbsolute(resolved)) {
    throw new Error(`extraRoot must resolve to an absolute path: ${rootPath}`);
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`extraRoot does not exist: ${resolved}`);
  }

  return resolved;
}

function getPythonCommand(scriptPath: string, extraRoots: string[]): { command: string; args: string[] } {
  const scriptArgs = [scriptPath, '--no-gui', '--json'];

  for (const rootPath of extraRoots) {
    scriptArgs.push('--extra-root', rootPath);
  }

  if (process.platform === 'win32') {
    return { command: 'py', args: ['-3', ...scriptArgs] };
  }

  return { command: 'python3', args: scriptArgs };
}

function runInspector(command: string, args: string[]): Promise<AgentComponentFinding[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      timeout: 30000
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Inspector exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout || '[]');
        resolve(Array.isArray(parsed) ? parsed as AgentComponentFinding[] : []);
      } catch (err: any) {
        reject(new Error(`Inspector returned invalid JSON: ${err.message}`));
      }
    });
  });
}

function summarize(findings: AgentComponentFinding[]): Record<string, number> {
  const summary: Record<string, number> = {};

  for (const finding of findings) {
    const key = `${finding.risk || 'unknown'}:${finding.status || 'unknown'}`;
    summary[key] = (summary[key] || 0) + 1;
  }

  return summary;
}

export async function inspectAgentEnvironmentComponents(
  options: AgentComponentInspectionOptions = {}
): Promise<AgentComponentInspectionReport> {
  const scriptPath = getInspectorScriptPath();

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Agent component inspector script was not found: ${scriptPath}`);
  }

  const extraRoots = (options.extraRoots || []).map(assertSafeRoot);
  const limit = normalizeLimit(options.maxFindings);
  const cacheTtlMs = normalizeCacheTtl(options.cacheTtlMs);
  const cacheKey = JSON.stringify(extraRoots);
  const now = Date.now();
  const cachedEntry = options.useCache !== false
    && cacheTtlMs > 0
    && inspectorCache?.key === cacheKey
    && now - inspectorCache.createdAt <= cacheTtlMs
    ? inspectorCache
    : undefined;
  const cached = Boolean(cachedEntry);
  const { command, args } = getPythonCommand(scriptPath, extraRoots);
  const findings = cachedEntry ? cachedEntry.findings : await runInspector(command, args);

  if (!cached) {
    inspectorCache = {
      key: cacheKey,
      createdAt: now,
      findings
    };
  }

  const limitedFindings = findings.slice(0, limit).map(finding => {
    if (options.includeInstructions) {
      return finding;
    }

    const { instruction, ...compactFinding } = finding;
    return compactFinding as AgentComponentFinding;
  });

  return {
    inspector: 'agent-environment-component-inspector',
    mode: 'read-only',
    cached,
    findingCount: findings.length,
    returnedCount: limitedFindings.length,
    truncated: findings.length > limitedFindings.length,
    summary: summarize(findings),
    findings: limitedFindings
  };
}
