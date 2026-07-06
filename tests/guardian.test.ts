import {
  planGuardianAudit,
  reviewAgentActionPlan,
  scoreAgentSurface,
  triageGuardianFindings
} from '../src/agent/guardian.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  createWorkflowId,
  loadWorkflowState,
  saveWorkflowState,
  type GuardianWorkflowState
} from '../src/agent/workflowState.js';

describe('Guardian agent layer', () => {
  it('plans an on-demand audit without removed tools', () => {
    const plan = planGuardianAudit({ workspaceRoot: 'C:/workspace/app' });
    const tools = plan.steps.map(step => step.tool);

    expect(tools).toEqual(expect.arrayContaining([
      'inspect_agent_environment_components',
      'discover_mcp_servers',
      'audit_security_posture'
    ]));
    expect(tools).not.toContain('audit_file_encodings');
  });

  it('blocks risky shell actions until explicitly allowed', () => {
    const review = reviewAgentActionPlan({
      proposedAction: 'rm -rf node_modules && npm publish',
      files: ['package.json'],
      allowWrites: false,
      allowShell: false
    });

    expect(review.allowed).toBe(false);
    expect(review.risk).toBe('high');
    expect(review.requiresCheckpoint).toBe(true);
    expect(review.reasons).toEqual(expect.arrayContaining([
      'Destructive delete command detected.',
      'Publishing or remote side-effect command detected.'
    ]));
  });

  it('scores and triages compact inspector findings', () => {
    const findings = [{
      name: 'Broad MCP filesystem access',
      risk: 'high',
      status: 'active',
      path: 'mcp.json',
      details: 'MCP server can access a broad filesystem root.'
    }] as const;

    const score = scoreAgentSurface(findings);
    const triage = triageGuardianFindings(findings);

    expect(score.score).toBeLessThan(100);
    expect(score.topRisks[0]?.name).toBe('Broad MCP filesystem access');
    expect(triage.mustFix).toHaveLength(1);
  });

  it('persists compact workflow state for resumable agent loops', async () => {
    const previousStoreDir = process.env.AGENTOPS_STORE_DIR;
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentops-workflow-test-'));
    process.env.AGENTOPS_STORE_DIR = storeDir;
    const workflowId = createWorkflowId();
    const state: GuardianWorkflowState = {
      workflowId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workspaceRoot: storeDir,
      mode: 'cheap',
      status: 'needs_user_approval',
      proposedAction: 'edit package.json',
      completedSteps: ['plan', 'review'],
      nextActions: ['Ask for approval.'],
      review: { allowed: false },
      surfaceScore: { score: 90 },
      inspection: { findingCount: 0 },
      checkpoints: []
    };

    try {
      const statePath = await saveWorkflowState(state);
      const loaded = await loadWorkflowState(workflowId);

      expect(statePath).toContain(workflowId);
      expect(loaded?.workflowId).toBe(workflowId);
      expect(loaded?.completedSteps).toEqual(['plan', 'review']);
    } finally {
      if (previousStoreDir === undefined) {
        delete process.env.AGENTOPS_STORE_DIR;
      } else {
        process.env.AGENTOPS_STORE_DIR = previousStoreDir;
      }
    }
  });
});
