import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { getStoreDir } from './store.js';

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;

  const storeDir = getStoreDir();
  await fs.mkdir(storeDir, { recursive: true });
  const dbPath = path.join(storeDir, 'project.db');

  // Open the SQLite database
  dbInstance = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Create checkpoints table
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      file_path TEXT,
      timestamp TEXT,
      content_hash TEXT,
      content_blob TEXT
    );
  `);

  // Create project memory FTS table
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      file_name TEXT PRIMARY KEY,
      title TEXT,
      content TEXT,
      affected_files TEXT,
      last_updated TEXT
    );
  `);

  // Try creating FTS5 virtual table for project memory
  try {
    await dbInstance.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
        file_name,
        title,
        content,
        affected_files
      );
    `);
  } catch {
    // Fallback if FTS5 is not compiled (highly unlikely in modern SQLite, but safe fallback)
    await dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS memory_search_fallback (
        file_name TEXT PRIMARY KEY,
        title TEXT,
        content TEXT,
        affected_files TEXT
      );
    `);
  }

  return dbInstance;
}

function getMaxFileSize(): number {
  if (process.env.AGENTOPS_MAX_CHECKPOINT_SIZE) {
    const parsed = parseInt(process.env.AGENTOPS_MAX_CHECKPOINT_SIZE, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed * 1024 * 1024; // MB to bytes
    }
  }
  return 10 * 1024 * 1024; // Default 10MB
}

export async function createCheckpoint(
  sessionId: string,
  filePath: string
): Promise<{ success: boolean; checkpointId?: string; hash?: string; warning?: string }> {
  try {
    const absolutePath = path.resolve(filePath).replace(/\\/g, '/');

    const maxFileSize = getMaxFileSize();
    // 1. Read file stats
    const stats = await fs.stat(absolutePath);
    if (stats.size > maxFileSize) {
      return {
        success: false,
        warning: `File size exceeds the limit (${(stats.size / (1024 * 1024)).toFixed(2)}MB > ${(maxFileSize / (1024 * 1024))}MB). Checkpoint skipped.`
      };
    }

    // 2. Read file content
    const content = await fs.readFile(absolutePath, 'utf8');

    // 3. Compute hash
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // 4. Save to DB
    const db = await getDb();
    
    // Check if the latest checkpoint already has the same hash to prevent duplicate storage
    const latest = await db.get(
      'SELECT content_hash FROM checkpoints WHERE file_path = ? ORDER BY timestamp DESC LIMIT 1',
      [absolutePath]
    );

    if (latest && latest.content_hash === hash) {
      return {
        success: true,
        hash,
        warning: 'File content is identical to the latest checkpoint. Skip saving duplicate.'
      };
    }

    const checkpointId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    await db.run(
      `INSERT INTO checkpoints (id, session_id, file_path, timestamp, content_hash, content_blob)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [checkpointId, sessionId, absolutePath, timestamp, hash, content]
    );

    return {
      success: true,
      checkpointId,
      hash
    };
  } catch (err: any) {
    return {
      success: false,
      warning: `Failed to create checkpoint: ${err.message}`
    };
  }
}

export async function restoreCheckpoint(
  checkpointId?: string,
  filePath?: string
): Promise<{ success: boolean; restoredPath?: string; message: string }> {
  try {
    const db = await getDb();
    let record: any = null;

    if (checkpointId) {
      record = await db.get('SELECT file_path, content_blob FROM checkpoints WHERE id = ?', [checkpointId]);
    } else if (filePath) {
      const absolutePath = path.resolve(filePath).replace(/\\/g, '/');
      record = await db.get(
        'SELECT file_path, content_blob FROM checkpoints WHERE file_path = ? ORDER BY timestamp DESC LIMIT 1',
        [absolutePath]
      );
    }

    if (!record) {
      return {
        success: false,
        message: 'No matching checkpoint found.'
      };
    }

    // Write contents back to file
    await fs.writeFile(record.file_path, record.content_blob, 'utf8');

    return {
      success: true,
      restoredPath: record.file_path,
      message: `Successfully restored file to saved state.`
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to restore checkpoint: ${err.message}`
    };
  }
}
