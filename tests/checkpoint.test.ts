import fs from 'fs/promises';
import path from 'path';
import { createCheckpoint, restoreCheckpoint, getDb } from '../src/observability/checkpoint.js';

describe('SQLite Checkpoint Manager', () => {
  const tempStore = path.join(__dirname, 'temp_checkpoint_store');
  const testFile = path.join(tempStore, 'workspace_file.txt');
  const sessionId = '87654321-4321-4321-4321-210987654321';

  beforeAll(async () => {
    process.env.AGENTOPS_STORE_DIR = tempStore;
    await fs.mkdir(tempStore, { recursive: true });
    // Write baseline content to test file
    await fs.writeFile(testFile, 'Original Baseline Content', 'utf8');
  });

  afterAll(async () => {
    // Close SQLite DB connection before deleting files to release file locks on Windows
    const db = await getDb();
    await db.close();
    await fs.rm(tempStore, { recursive: true, force: true });
    delete process.env.AGENTOPS_STORE_DIR;
  });

  test('creates SQLite checkpoint of target file', async () => {
    const result = await createCheckpoint(sessionId, testFile);
    expect(result.success).toBe(true);
    expect(result.checkpointId).toBeDefined();
    expect(result.hash).toBeDefined();

    // Verify it saved in DB
    const db = await getDb();
    const row = await db.get('SELECT * FROM checkpoints WHERE id = ?', [result.checkpointId]);
    expect(row).toBeDefined();
    expect(row.file_path).toBe(testFile.replace(/\\/g, '/'));
    expect(row.content_blob).toBe('Original Baseline Content');
  });

  test('restores file to checkpoint state after modification', async () => {
    // Modify file
    await fs.writeFile(testFile, 'Corrupted Content by Agent', 'utf8');

    // Restore to latest checkpoint
    const restoreResult = await restoreCheckpoint(undefined, testFile);
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.restoredPath).toBe(testFile.replace(/\\/g, '/'));

    // Check content has reverted
    const revertedContent = await fs.readFile(testFile, 'utf8');
    expect(revertedContent).toBe('Original Baseline Content');
  });
});
