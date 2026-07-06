import fs from 'fs/promises';
import path from 'path';
import { ProjectInfo, DriftWarning } from '../types.js';

export async function auditDrift(projects: ProjectInfo[]): Promise<DriftWarning[]> {
  const warnings: DriftWarning[] = [];
  const projectNames = new Map<string, string[]>();
  const dependencyVersions = new Map<string, Map<string, string>>(); // depName -> projectPath -> version

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  for (const project of projects) {
    // 1. Check for stale projects (no modification for 6 months)
    const mTime = new Date(project.lastModified);
    if (mTime < sixMonthsAgo) {
      warnings.push({
        projectPath: project.path,
        type: 'stale',
        message: `Project has not been modified since ${project.lastModified} (over 6 months ago).`,
        severity: 'low'
      });
    }

    // 2. Track duplicate project names
    const existingPaths = projectNames.get(project.name) || [];
    existingPaths.push(project.path);
    projectNames.set(project.name, existingPaths);

    // 3. Extract Node.js dependencies to check for version mismatch
    if (project.type === 'nodejs') {
      try {
        const pkgJsonPath = path.join(project.path, 'package.json');
        const content = await fs.readFile(pkgJsonPath, 'utf8');
        const parsed = JSON.parse(content);
        const deps = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };

        for (const [depName, version] of Object.entries(deps)) {
          if (typeof version !== 'string') continue;
          let depMap = dependencyVersions.get(depName);
          if (!depMap) {
            depMap = new Map<string, string>();
            dependencyVersions.set(depName, depMap);
          }
          depMap.set(project.path, version);
        }
      } catch {
        // Skip package.json parse errors
      }
    }
  }

  // Generate warnings for duplicate project names
  for (const [name, paths] of projectNames.entries()) {
    if (paths.length > 1) {
      for (const p of paths) {
        warnings.push({
          projectPath: p,
          type: 'duplicate',
          message: `Duplicate project name "${name}" found. Sibling locations: ${paths.filter(x => x !== p).join(', ')}`,
          severity: 'medium'
        });
      }
    }
  }

  // Generate warnings for version mismatches
  for (const [depName, depMap] of dependencyVersions.entries()) {
    if (depMap.size > 1) {
      const versions = Array.from(depMap.entries());
      const uniqueVersions = new Set(versions.map(([_, v]) => v));

      if (uniqueVersions.size > 1) {
        // Version mismatch across projects
        const details = versions.map(([proj, ver]) => `${path.basename(proj)} (${ver})`).join(', ');
        for (const [proj, ver] of versions) {
          warnings.push({
            projectPath: proj,
            type: 'version_mismatch',
            message: `Dependency version mismatch for "${depName}" across projects: ${details}`,
            severity: 'medium'
          });
        }
      }
    }
  }

  return warnings;
}
