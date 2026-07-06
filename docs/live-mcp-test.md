# Live MCP Test

Date: 2026-07-05

This test was run after registering AgentOps Guardian in an MCP-compatible AI coding client as `mcp__agentops_guardian`.

## MCP Availability

The MCP client exposed the `mcp__agentops_guardian` namespace after restart. The visible tools included:

- `guardian_run_workflow`
- `restore_latest`
- `safe_checkpoint`
- `inspect_agent_environment_components`
- `score_agent_surface`
- `triage_guardian_findings`

## Workflow Smoke Test

Input:

```json
{
  "workspaceRoot": "<workspace-root>",
  "proposedAction": "Append a short smoke-test line to .agentops-demo/demo-target.txt",
  "files": [
    "<workspace-root>\\.agentops-demo\\demo-target.txt"
  ],
  "mode": "cheap",
  "allowWrites": false,
  "allowShell": false,
  "createCheckpoints": true,
  "maxFindings": 3
}
```

Observed result:

- `guardian_run_workflow` returned `needs_user_approval`.
- The workflow completed `plan, inspect, score, triage, review, checkpoint, persist_state`.
- It created one successful checkpoint.
- It persisted workflow state to `.agentops/workflows/guardian-workflow-1783245551350-43d84ce9.json`.
- It returned compact inspection counts and top risks without verbose remediation instructions.

## Restore Smoke Test

Manual test action:

1. Add a temporary line to `.agentops-demo/demo-target.txt`.
2. Call `restore_latest` for that file.
3. Verify the temporary line is gone.

Observed result:

```json
{
  "success": true,
  "restoredPath": "<workspace-root>/.agentops-demo/demo-target.txt",
  "message": "Successfully restored file to saved state."
}
```

Verification:

- The temporary smoke-test line was absent after restore.

## Capstone Evidence

This demonstrates the intended agent loop:

1. The user proposes a risky or file-changing action.
2. Guardian inspects the agent/MCP environment lazily.
3. Guardian scores and triages compact findings.
4. Guardian reviews the proposed action against guardrails.
5. Guardian creates rollback checkpoints.
6. Guardian persists small workflow state.
7. Guardian blocks work until approval when writes are not allowed.
8. Guardian can restore the checkpointed file.

The test used explicit user-triggered MCP calls only. No background monitor, daemon, or continuous event logging was involved.
