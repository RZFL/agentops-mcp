import fs from 'fs/promises';
import path from 'path';
import { ProjectInfo } from '../types.js';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'venv',
  'env',
  '.gradle',
  '.idea',
  'target',
  'bin',
  'obj',
  '__pycache__',
  '.agents',
  '.agentops'
]);

async function getDirectoryStats(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath);
    return entries;
  } catch {
    return [];
  }
}

export async function discoverProjects(
  rootPaths: string[],
  maxDepth: number = 4
): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];

  async function scan(currentPath: string, depth: number) {
    if (depth > maxDepth) return;

    const entries = await getDirectoryStats(currentPath);
    if (entries.length === 0) return;

    let projectType: ProjectInfo['type'] = 'unknown';
    const mainFiles: string[] = [];

    // Analyze entries in the current directory
    for (const entry of entries) {
      if (entry === 'package.json') {
        projectType = 'nodejs';
        mainFiles.push(entry);
      } else if (entry === 'requirements.txt' || entry === 'pyproject.toml' || entry === 'setup.py') {
        projectType = 'python';
        mainFiles.push(entry);
      } else if (entry === 'pom.xml' || entry === 'build.gradle') {
        projectType = 'java';
        mainFiles.push(entry);
      } else if (entry === 'go.mod') {
        projectType = 'go';
        mainFiles.push(entry);
      } else if (entry === 'Dockerfile') {
        if (projectType === 'unknown') {
          projectType = 'docker';
        }
        mainFiles.push(entry);
      }
    }

    if (projectType !== 'unknown') {
      try {
        const stats = await fs.stat(currentPath);
        projects.push({
          path: path.resolve(currentPath).replace(/\\/g, '/'),
          name: path.basename(currentPath),
          type: projectType,
          mainFiles,
          lastModified: stats.mtime.toISOString()
        });
        // Once we find a project, we don't necessarily need to recurse deeper inside it (e.g. nested packages),
        // but we might want to scan sibling folders, so we return here to avoid scanning inside a project's subdirectories
        // unless they are explicitly nested structures, but for simplicity in MVP we stop recursing inside found projects.
        return;
      } catch {
        // Ignore stat errors
      }
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;

      const fullPath = path.join(currentPath, entry);
      try {
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          await scan(fullPath, depth + 1);
        }
      } catch {
        // Ignore errors for unreadable directories/files
      }
    }
  }

  for (const root of rootPaths) {
    try {
      const stats = await fs.stat(root);
      if (stats.isDirectory()) {
        await scan(root, 1);
      }
    } catch {
      // Ignore invalid root paths
    }
  }

  return projects;
}
