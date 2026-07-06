import { exec } from 'child_process';
import { RuntimeInfo } from '../types.js';

function runCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: 3000 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ? stdout.trim() : '',
        stderr: stderr ? stderr.trim() : ''
      });
    });
  });
}

export async function auditRuntimes(): Promise<RuntimeInfo[]> {
  const checkList = [
    {
      name: 'Node.js',
      command: 'node -v',
      regex: /v?(\d+\.\d+\.\d+)/
    },
    {
      name: 'Python',
      command: 'python --version',
      regex: /Python\s+(\d+\.\d+\.\d+)/
    },
    {
      name: 'Docker',
      command: 'docker -v',
      regex: /version\s+(\d+\.\d+\.\d+)/i
    },
    {
      name: 'Git',
      command: 'git --version',
      regex: /git\s+version\s+(\d+\.\d+\.\d+)/
    },
    {
      name: 'Java',
      command: 'java -version',
      // Note: java -version output goes to stderr
      regex: /(?:openjdk|java)\s+version\s+["']?(\d+(?:\.\d+)*)/i
    }
  ];

  const results: RuntimeInfo[] = [];

  for (const item of checkList) {
    try {
      const { stdout, stderr } = await runCommand(item.command);
      const output = (stdout + '\n' + stderr).trim();
      const match = output.match(item.regex);

      if (match && match[1]) {
        // Query the path of the binary using 'where' on Windows
        let binaryPath = '';
        try {
          const pathCheck = await runCommand(`where.exe ${item.command.split(' ')[0]}`);
          if (pathCheck.stdout) {
            binaryPath = pathCheck.stdout.split('\n')[0].trim().replace(/\\/g, '/');
          }
        } catch {
          // Ignore path resolution failure
        }

        results.push({
          name: item.name,
          installed: true,
          version: match[1],
          path: binaryPath || undefined
        });
      } else {
        results.push({
          name: item.name,
          installed: false,
          error: output || 'Not found in PATH'
        });
      }
    } catch (err: any) {
      results.push({
        name: item.name,
        installed: false,
        error: err.message || 'Unknown error during execution'
      });
    }
  }

  return results;
}
