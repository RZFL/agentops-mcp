import fs from 'fs';
import path from 'path';

export function getStoreDir(): string {
  const configuredDir = process.env.AGENTOPS_STORE_DIR;
  const storeDir = configuredDir && configuredDir.trim().length > 0
    ? configuredDir
    : path.join(process.cwd(), '.agentops');

  const resolved = path.resolve(storeDir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function getSessionsDir(): string {
  const sessionsDir = path.join(getStoreDir(), 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return sessionsDir;
}
