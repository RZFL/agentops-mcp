import fs from 'fs/promises';
import path from 'path';

import { inspectAgentEnvironmentComponents } from '../auditor/agentComponents.js';
import {
  planGuardianAudit,
  reviewAgentActionPlan,
  scoreAgentSurface,
  triageGuardianFindings
} from '../agent/guardian.js';
import {
  createWorkflowId,
  saveWorkflowState,
  type GuardianWorkflowCheckpoint,
  type GuardianWorkflowState
} from '../agent/workflowState.js';
import { createCheckpoint } from '../observability/checkpoint.js';

async function main() {
  const workspaceRoot = process.cwd();
  const demoDir = path.join(workspaceRoot, '.agentops-demo');
  const targetFile = path.join(demoDir, 'demo-target.txt');
  const proposedAction = `powershell Remove-Item ${targetFile} -Force`;
  const workflowId = createWorkflowId();

  await fs.mkdir(demoDir, { recursive: true });
  await fs.writeFile(targetFile, 'safe demo content\n', 'utf8');

  const plan = planGuardianAudit({
    workspaceRoot,
    goal: proposedAction,
    depth: 'quick'
  });
  const inspection = await inspectAgentEnvironmentComponents({
    extraRoots: [workspaceRoot],
    maxFindings: 5,
    includeInstructions: false
  });
  const surfaceScore = scoreAgentSurface(inspection.findings);
  const triage = triageGuardianFindings(inspection.findings);
  const review = reviewAgentActionPlan({
    workspaceRoot,
    proposedAction,
    files: [targetFile],
    allowWrites: true,
    allowShell: false
  });
  const checkpoint = await createCheckpoint(workflowId, targetFile);
  const checkpoints: GuardianWorkflowCheckpoint[] = [{
    filePath: targetFile,
    success: Boolean((checkpoint as any).success),
    checkpointId: (checkpoint as any).checkpointId,
    error: (checkpoint as any).success ? undefined : (checkpoint as any).error || 'Checkpoint was not created.'
  }];
  const status = checkpoints[0].success && review.allowed
    ? 'ready'
    : review.risk === 'high'
      ? 'blocked'
      : 'needs_user_approval';
  const now = new Date().toISOString();
  const state: GuardianWorkflowState = {
    workflowId,
    createdAt: now,
    updatedAt: now,
    workspaceRoot,
    mode: 'cheap',
    status,
    proposedAction,
    completedSteps: ['plan', 'inspect', 'score', 'triage', 'review', 'checkpoint', 'persist_state'],
    nextActions: [
      'Do not execute the proposed shell command yet.',
      'Ask for explicit shell approval or narrow the action.',
      'Use restore_latest if the protected file is changed incorrectly.'
    ],
    review,
    surfaceScore,
    inspection: {
      cached: inspection.cached,
      findingCount: inspection.findingCount,
      returnedCount: inspection.returnedCount,
      summary: inspection.summary,
      mustFixCount: triage.mustFix.length,
      reviewCount: triage.review.length
    },
    checkpoints
  };
  const statePath = await saveWorkflowState(state);

  console.log(JSON.stringify({
    workflowId,
    statePath,
    status,
    proposedAction,
    completedSteps: state.completedSteps,
    review,
    surfaceScore: {
      score: surfaceScore.score,
      risk: surfaceScore.risk,
      summary: surfaceScore.summary,
      recommendations: surfaceScore.recommendations
    },
    checkpoints,
    nextActions: state.nextActions,
    planTools: plan.steps.map(step => step.tool)
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
