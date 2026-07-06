import fs from 'fs/promises';
import path from 'path';
import { SecurityFinding, SecurityPostureReport } from '../types.js';

const RULE_FILES = [
  'AGENTS.md',
  'AGENTS.md.example',
  '.cursorrules',
  '.cursor/rules',
  '.github/copilot-instructions.md'
];

const MCP_CONFIG_FILES = [
  '.mcp.json',
  'mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json'
];

const TEXT_EXTENSIONS = new Set(['.md', '.json', '.js', '.ts', '.env', '.txt', '.yml', '.yaml']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.agentops']);

const SECURITY_PATTERNS: Array<{
  id: string;
  severity: SecurityFinding['severity'];
  pattern: RegExp;
  message: string;
  recommendation: string;
}> = [
  {
    id: 'dangerous-delete',
    severity: 'high',
    pattern: /\b(rm\s+-rf|git\s+clean\s+-fd|del\s+\/s|Remove-Item\b.*-Recurse)/i,
    message: 'Potentially destructive command is referenced.',
    recommendation: 'Require explicit approval and a checked absolute target before destructive operations.'
  },
  {
    id: 'unsafe-shell-install',
    severity: 'high',
    pattern: /(curl|wget|irm|iwr).*(\||;).*(bash|sh|iex|Invoke-Expression)/i,
    message: 'Remote script execution pattern is referenced.',
    recommendation: 'Download, pin, inspect, and verify installers before execution.'
  },
  {
    id: 'approval-bypass',
    severity: 'high',
    pattern: /(never ask.*approval|do not ask.*approval|ignore.*safety|ignore.*policy)/i,
    message: 'Instruction may bypass safety or approval checks.',
    recommendation: 'Keep approval and safety policies explicit and non-overridable.'
  },
  {
    id: 'secret-looking-value',
    severity: 'medium',
    pattern: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
    message: 'Possible secret value is present in a project file.',
    recommendation: 'Move secrets to local environment variables and keep only placeholders in tracked files.'
  },
  {
    id: 'wide-filesystem-access',
    severity: 'medium',
    pattern: /\b(C:\\|\/|~\/|\$HOME)\b.*\b(write|delete|modify|overwrite|Remove-Item|rm\s+-rf)\b/i,
    message: 'Broad filesystem access instruction is referenced.',
    recommendation: 'Constrain writes to the current workspace or a clearly named output directory.'
  }
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, relativePath: string): Promise<string[]> {
  const absolutePath = path.join(root, relativePath);
  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isFile()) return [absolutePath];
    if (!stats.isDirectory()) return [];

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          files.push(...await collectFiles(root, path.join(relativePath, entry.name)));
        }
      } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.join(absolutePath, entry.name));
      }
    }
    return files;
  } catch {
    return [];
  }
}

function addPatternFindings(filePath: string, content: string, findings: SecurityFinding[]) {
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of SECURITY_PATTERNS) {
      if (rule.pattern.test(line)) {
        findings.push({
          id: rule.id,
          severity: rule.severity,
          filePath: filePath.replace(/\\/g, '/'),
          line: index + 1,
          message: rule.message,
          recommendation: rule.recommendation
        });
      }
    }
  });
}

async function readJson(filePath: string): Promise<any | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

async function auditPackageScripts(root: string, findings: SecurityFinding[]) {
  const packagePath = path.join(root, 'package.json');
  const parsed = await readJson(packagePath);
  if (!parsed?.scripts) return;

  for (const [name, command] of Object.entries(parsed.scripts)) {
    if (typeof command !== 'string') continue;
    for (const rule of SECURITY_PATTERNS) {
      if (rule.pattern.test(command)) {
        findings.push({
          id: `package-script-${rule.id}`,
          severity: rule.severity,
          filePath: packagePath.replace(/\\/g, '/'),
          message: `Script "${name}" contains a risky command pattern.`,
          recommendation: rule.recommendation
        });
      }
    }
  }
}

async function auditMcpConfig(root: string, relativePath: string, findings: SecurityFinding[]) {
  const configPath = path.join(root, relativePath);
  const parsed = await readJson(configPath);
  if (!parsed?.mcpServers) return;

  for (const [serverName, config] of Object.entries<any>(parsed.mcpServers)) {
    const command = `${config.command || ''} ${(config.args || []).join(' ')}`;
    if (/\b(powershell|pwsh|cmd|bash|sh)\b/i.test(command)) {
      findings.push({
        id: 'shell-backed-mcp-server',
        severity: 'medium',
        filePath: configPath.replace(/\\/g, '/'),
        message: `MCP server "${serverName}" is launched through a general-purpose shell.`,
        recommendation: 'Prefer a direct executable plus fixed args, and document why shell execution is required.'
      });
    }
    if (config.env) {
      findings.push({
        id: 'mcp-inline-env',
        severity: 'low',
        filePath: configPath.replace(/\\/g, '/'),
        message: `MCP server "${serverName}" defines inline environment variables.`,
        recommendation: 'Keep secrets out of config files; use local environment variables for sensitive values.'
      });
    }
  }
}

async function auditSafetyDocs(root: string, findings: SecurityFinding[]) {
  const agentsPath = path.join(root, 'AGENTS.md');
  if (!(await exists(agentsPath))) {
    findings.push({
      id: 'missing-agents-md',
      severity: 'medium',
      filePath: agentsPath.replace(/\\/g, '/'),
      message: 'Workspace has no AGENTS.md guidance file.',
      recommendation: 'Add explicit agent rules for approvals, checkpoints, testing, and filesystem boundaries.'
    });
    return;
  }

  const content = await fs.readFile(agentsPath, 'utf8');
  for (const keyword of ['checkpoint', 'approval', 'test']) {
    if (!content.toLowerCase().includes(keyword)) {
      findings.push({
        id: `agents-md-missing-${keyword}`,
        severity: 'low',
        filePath: agentsPath.replace(/\\/g, '/'),
        message: `AGENTS.md does not mention "${keyword}".`,
        recommendation: 'Document this safety expectation so agents follow a repeatable workflow.'
      });
    }
  }
}

export async function auditSecurityPosture(workspaceRoot: string): Promise<SecurityPostureReport> {
  const root = path.resolve(workspaceRoot);
  const findings: SecurityFinding[] = [];

  for (const relativePath of RULE_FILES) {
    const files = await collectFiles(root, relativePath);
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      addPatternFindings(file, content, findings);
    }
  }

  for (const relativePath of MCP_CONFIG_FILES) {
    await auditMcpConfig(root, relativePath, findings);
  }

  await auditPackageScripts(root, findings);
  await auditSafetyDocs(root, findings);

  const summary = {
    high: findings.filter(f => f.severity === 'high').length,
    medium: findings.filter(f => f.severity === 'medium').length,
    low: findings.filter(f => f.severity === 'low').length
  };

  const score = Math.max(0, 100 - summary.high * 25 - summary.medium * 10 - summary.low * 3);

  return {
    workspaceRoot: root.replace(/\\/g, '/'),
    score,
    findings,
    summary
  };
}
