import fs from 'fs/promises';
import path from 'path';
import { discoverProjects } from '../src/auditor/projects.js';

describe('Project Scanner', () => {
  const tempScanDir = path.join(__dirname, 'temp_project_scan');

  beforeAll(async () => {
    await fs.mkdir(tempScanDir, { recursive: true });

    // 1. Create a mock Node.js project
    const nodeProj = path.join(tempScanDir, 'node-app');
    await fs.mkdir(nodeProj, { recursive: true });
    await fs.writeFile(path.join(nodeProj, 'package.json'), '{}');

    // 2. Create a mock Python project
    const pyProj = path.join(tempScanDir, 'python-app');
    await fs.mkdir(pyProj, { recursive: true });
    await fs.writeFile(path.join(pyProj, 'requirements.txt'), '');

    // 3. Create a node_modules directory which must be IGNORED
    const ignoredNodeModules = path.join(nodeProj, 'node_modules');
    await fs.mkdir(ignoredNodeModules, { recursive: true });
    await fs.writeFile(path.join(ignoredNodeModules, 'package.json'), '{}'); // nested package.json inside node_modules
  });

  afterAll(async () => {
    await fs.rm(tempScanDir, { recursive: true, force: true });
  });

  test('discoverProjects detects code projects and ignores node_modules', async () => {
    const projects = await discoverProjects([tempScanDir], 3);
    
    expect(projects.length).toBe(2);
    
    const nodeApp = projects.find(p => p.name === 'node-app');
    expect(nodeApp).toBeDefined();
    expect(nodeApp?.type).toBe('nodejs');
    expect(nodeApp?.mainFiles).toContain('package.json');

    const pyApp = projects.find(p => p.name === 'python-app');
    expect(pyApp).toBeDefined();
    expect(pyApp?.type).toBe('python');
    expect(pyApp?.mainFiles).toContain('requirements.txt');

    // Ensure it did not find the nested package.json inside node_modules
    const ignoredApp = projects.find(p => p.path.includes('node_modules'));
    expect(ignoredApp).toBeUndefined();
  });
});
