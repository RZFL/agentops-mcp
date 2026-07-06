import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { auditMCPServers, parseCodexMcpServers } from '../src/auditor/mcp.js';

describe('MCP config auditor', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('parses Codex MCP server config', () => {
    const servers = parseCodexMcpServers(`
[mcp_servers.agentops-guardian]
command = 'C:\\Program Files\\nodejs\\node.exe'
args = ['H:\\repo\\dist\\index.js']
cwd = 'H:\\repo'
enabled = true

[mcp_servers.lpeg-alt-1c-mcp]
command = 'D:\\LPEG_ALT_1C_MCP\\.venv\\Scripts\\python.exe'
args = ['D:\\LPEG_ALT_1C_MCP\\server.py']

[mcp_servers.lpeg-alt-1c-mcp.env]
RAG_ENABLED = "false"
`);

    expect(Object.keys(servers)).toEqual(['agentops-guardian', 'lpeg-alt-1c-mcp']);
    expect(servers['agentops-guardian']).toMatchObject({
      name: 'agentops-guardian',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['H:\\repo\\dist\\index.js']
    });
    expect(servers['lpeg-alt-1c-mcp'].env).toEqual({ RAG_ENABLED: 'false' });
  });

  test('redacts MCP environment values in audit output', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agentops-mcp-'));
    jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, '.codex', 'config.toml'),
      [
        '[mcp_servers.example]',
        "command = 'node'",
        "args = ['server.js']",
        '',
        '[mcp_servers.example.env]',
        'API_TOKEN = "secret-value"'
      ].join('\n')
    );

    const results = await auditMCPServers();

    expect(results[0].servers.example.env).toEqual({ API_TOKEN: '*****' });
    await fs.rm(tempHome, { recursive: true, force: true });
  });
});
