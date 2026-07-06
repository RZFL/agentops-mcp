# Agent Guidelines

## Project Purpose

AgentOps Guardian MCP is a local-first MCP safety agent for AI coding workflows. It helps developers review risky actions, create file checkpoints, and roll back workflow changes when an agent makes an unsafe edit.

## Core Capabilities

- `guardian_run_workflow`: inspect an action, score risk, create checkpoints when needed, and return a structured decision.
- `guardian_restore_workflow`: restore every file checkpointed by a saved workflow.
- `safe_checkpoint` and `restore_latest`: lightweight file-level rollback helpers.
- `inspect_agent_environment_components` and `score_agent_surface`: deterministic inspection of local agent/MCP/tooling configuration.

## Development Rules

- Keep the project local-first and deterministic.
- Prefer small TypeScript modules with explicit `try/catch` error handling.
- Return MCP tool errors inside structured tool output instead of uncaught process exceptions.
- Require explicit user approval before destructive shell commands, publishing, or release actions.
- Do not commit credentials, API keys, local `.env` files, generated build output, or local workflow state.
- Keep public documentation focused on the product, demo flow, and reproducible setup.

## Verification

Before final submission, run:

```bash
npm install
npm run check
npm test
npm run build
npm run demo:workflow
```
