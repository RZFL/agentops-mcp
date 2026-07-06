import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { MCPServerConfig, MCPServersAudit } from '../types.js';

export function getClaudeConfigPath(): string {
  const homeDir = os.homedir();
  const platform = os.platform();

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  } else if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else {
    return path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

export function getCodexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(part => String(parseTomlValue(part.trim())));
  }
  return trimmed;
}

export function parseCodexMcpServers(content: string): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  let currentServer: string | null = null;
  let inEnv = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const section = /^\[mcp_servers\.("?)([^".\]]+)\1(?:\.(env))?\]$/.exec(line);
    if (section) {
      currentServer = section[2];
      inEnv = section[3] === 'env';
      servers[currentServer] ||= { name: currentServer, command: '', args: [] };
      continue;
    }

    if (line.startsWith('[')) {
      currentServer = null;
      inEnv = false;
      continue;
    }

    if (!currentServer) continue;
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;

    const [, key, rawValue] = assignment;
    const value = parseTomlValue(rawValue);
    if (inEnv) {
      const env = servers[currentServer].env ?? {};
      env[key] = String(value);
      servers[currentServer].env = env;
    } else if (key === 'command') {
      servers[currentServer].command = String(value);
    } else if (key === 'args' && Array.isArray(value)) {
      servers[currentServer].args = value.map(String);
    }
  }

  return Object.fromEntries(
    Object.entries(servers).filter(([, server]) => server.command)
  );
}

function redactServerEnv(servers: Record<string, MCPServerConfig>): Record<string, MCPServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        ...server,
        ...(server.env ? { env: Object.fromEntries(Object.keys(server.env).map(key => [key, '*****'])) } : {})
      }
    ])
  );
}

export async function auditMCPServers(): Promise<MCPServersAudit[]> {
  const results: MCPServersAudit[] = [];
  const pathsToCheck = [
    { name: 'Claude Desktop', path: getClaudeConfigPath(), type: 'json' },
    { name: 'Codex', path: getCodexConfigPath(), type: 'toml' }
  ];

  for (const item of pathsToCheck) {
    try {
      const content = await fs.readFile(item.path, 'utf8');
      const servers = item.type === 'json'
        ? JSON.parse(content)?.mcpServers
        : parseCodexMcpServers(content);

      if (servers && Object.keys(servers).length > 0) {
        results.push({
          configPath: item.path.replace(/\\/g, '/'),
          servers: redactServerEnv(servers)
        });
      }
    } catch {
      // Configuration file not found or unreadable.
    }
  }

  return results;
}
