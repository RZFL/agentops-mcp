import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { getStoreDir } from '../observability/store.js';

export interface GuardianWorkflowCheckpoint {
  filePath: string;
  success: boolean;
  checkpointId?: string;
  error?: string;
}

export interface GuardianWorkflowState {
  workflowId: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  mode: 'cheap' | 'standard' | 'deep';
  status: 'blocked' | 'needs_user_approval' | 'ready';
  proposedAction: string;
  completedSteps: string[];
  nextActions: string[];
  review: unknown;
  surfaceScore: unknown;
  inspection: unknown;
  checkpoints: GuardianWorkflowCheckpoint[];
}

export function createWorkflowId(): string {
  return `guardian-workflow-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function workflowDir(): string {
  return path.join(getStoreDir(), 'workflows');
}

function workflowPath(workflowId: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(workflowId)) {
    throw new Error('workflowId may contain only letters, numbers, dot, dash, and underscore.');
  }

  return path.join(workflowDir(), `${workflowId}.json`);
}

export async function loadWorkflowState(workflowId: string): Promise<GuardianWorkflowState | undefined> {
  try {
    const content = await fs.readFile(workflowPath(workflowId), 'utf8');
    return JSON.parse(content) as GuardianWorkflowState;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return undefined;
    }

    throw err;
  }
}

export async function saveWorkflowState(state: GuardianWorkflowState): Promise<string> {
  await fs.mkdir(workflowDir(), { recursive: true });
  const filePath = workflowPath(state.workflowId);
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
  return filePath;
}
