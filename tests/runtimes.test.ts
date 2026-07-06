import { auditRuntimes } from '../src/auditor/runtimes.js';
import { exec } from 'child_process';

jest.mock('child_process', () => ({
  exec: jest.fn()
}));

describe('Runtime Detector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('auditRuntimes detects installed tools and versions successfully', async () => {
    const mockExec = exec as unknown as jest.Mock;
    
    // Setup sequential mock outputs for commands
    // 1. node -v
    // 2. where.exe node
    // 3. python --version
    // 4. where.exe python
    // 5. docker -v
    // 6. where.exe docker
    // 7. git --version
    // 8. where.exe git
    // 9. java -version
    // 10. where.exe java
    mockExec.mockImplementation((cmd, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
      }
      
      if (cmd.includes('node -v')) {
        callback(null, 'v20.11.0\n', '');
      } else if (cmd.includes('python --version')) {
        callback(null, 'Python 3.12.2\n', '');
      } else if (cmd.includes('docker -v')) {
        callback(null, 'Docker version 25.0.3, build 4debf41\n', '');
      } else if (cmd.includes('git --version')) {
        callback(null, 'git version 2.43.0.windows.1\n', '');
      } else if (cmd.includes('java -version')) {
        // Java version goes to stderr
        callback(null, '', 'openjdk version "21.0.2" 2024-01-16 LTS\n');
      } else if (cmd.startsWith('where.exe')) {
        const binName = cmd.split(' ')[1];
        callback(null, `C:\\bin\\${binName}.exe\n`, '');
      } else {
        callback(new Error('Command not found'), '', 'Error');
      }
    });

    const results = await auditRuntimes();
    
    // Verify Node
    const node = results.find(r => r.name === 'Node.js');
    expect(node).toBeDefined();
    expect(node?.installed).toBe(true);
    expect(node?.version).toBe('20.11.0');
    expect(node?.path).toBe('C:/bin/node.exe'); // normalized path

    // Verify Java (which goes to stderr)
    const java = results.find(r => r.name === 'Java');
    expect(java).toBeDefined();
    expect(java?.installed).toBe(true);
    expect(java?.version).toBe('21.0.2');
  });

  test('auditRuntimes reports uninstalled tools as not installed', async () => {
    const mockExec = exec as unknown as jest.Mock;
    
    // Mock all executions to fail (simulate commands missing in PATH)
    mockExec.mockImplementation((cmd, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
      }
      callback(new Error('Command not found'), '', 'command not found');
    });

    const results = await auditRuntimes();
    for (const r of results) {
      expect(r.installed).toBe(false);
    }
  });
});
