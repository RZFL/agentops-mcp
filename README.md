# AgentOps Guardian MCP

## Quick Install

Prerequisites:

- Node.js `20.17.0` or newer with `npm`.
- Git, only if you clone the repository.
- Python 3 is optional. It is used only by `npm run demo:inspector`; the core MCP server, tests, and workflow demo run on Node.js.
- No Docker, cloud service, external database, or API key is required for the local demo.

Install notes:

- Keep network access enabled for `npm install`.
- `sqlite3` normally installs a prebuilt native package. If npm falls back to compiling it, install the standard native build tools for your OS and rerun `npm install`.

Fresh local setup:

```bash
git clone <repo-url>
cd agentops-guardian-mcp
npm install
npm run check
npm test
npm run build
npm run demo:workflow
```

If an AI coding agent is installing this project, ask it to run the same commands and stop before any `git push`, `npm publish`, or GitHub release command. A healthy install ends with `demo:workflow` returning `status: "needs_user_approval"`.

MCP hosts should point to the built server:

```json
{
  "mcpServers": {
    "agentops-guardian": {
      "command": "node",
      "args": ["C:/absolute/path/to/agentops-guardian-mcp/dist/index.js"]
    }
  }
}
```

On Windows, use absolute paths and escape backslashes if your MCP host requires JSON escaping.

---

## Capstone Summary

Track: Agents for Business  
Problem: AI coding agents can make risky local changes without rollback.  
Solution: MCP safety agent that reviews actions, checkpoints files, and restores workflow state.  
Demo: `guardian_run_workflow` blocks unsafe writes, creates checkpoints, and `guardian_restore_workflow` restores files.  
Course concepts: MCP, agent loop, skills/rules, security guardrails.

On-demand safety agent for AI coding workflows.

AgentOps Guardian MCP is a local-first Model Context Protocol server that helps developers inspect AI-agent workspaces, review risky actions, create rollback checkpoints, and restore files when an AI coding workflow goes wrong.

The project is designed for the **Agents for Business** track: it reduces the operational cost of using AI coding agents in real development teams.

---

## Key Features

- **One-call agent workflow:** `guardian_run_workflow` plans, inspects, scores, reviews a proposed action, checkpoints files, persists compact workflow state, and returns a compact decision.
- **Workflow rollback:** `guardian_restore_workflow` restores all files checkpointed by a saved Guardian workflow.
- **Backup first:** `safe_checkpoint`, `restore_latest`, and `prepare_safe_edit` remain direct recovery tools before risky edits.
- **Agent/MCP inspection:** `inspect_agent_environment_components` reports local agents, MCP servers, skills, plugins, hooks, model providers, and app integrations.
- **Cheap by default:** compact output, short in-memory inspector cache, no background daemon, no constant logging, and no automatic token-heavy summaries.
- **Security review:** deterministic checks flag shell execution, file writes without approval, destructive commands, publishing commands, and secret-looking actions.

---

## Architecture

The main loop is:

```text
proposed action
  -> guardian_run_workflow
  -> plan
  -> inspect agent/MCP environment
  -> score and triage risks
  -> review proposed action
  -> create checkpoints
  -> persist workflow state
  -> return decision and next action
```

If the result is wrong:

```text
guardian_restore_workflow(workflowId)
  -> read .agentops/workflows/<workflowId>.json
  -> restore all successful checkpoints
```

See [docs/architecture.md](docs/architecture.md) for details.

---

## Setup

Install dependencies and build:

```bash
npm install
npm run build
```

Run checks:

```bash
npm run check
npm test
```

Start the MCP server:

```bash
npm start
```

## Main Tools

- `guardian_run_workflow` — top-level agent workflow.
- `guardian_restore_workflow` — restore all checkpointed files from a workflow.
- `safe_checkpoint` — quick backup for one file.
- `restore_latest` — restore the latest checkpoint for one file.
- `prepare_safe_edit` — review an edit and checkpoint target files.
- `inspect_agent_environment_components` — inspect local agent/MCP components.
- `score_agent_surface` — compact risk score for the local agent surface.
- `triage_guardian_findings` — group findings into must-fix, review, informational, and ignored buckets.
- `review_agent_action_plan` — deterministic safety review for a proposed action.

---

## Demo

Run the deterministic workflow demo:

```bash
npm run build
npm run demo:workflow
```

The demo creates a test file, proposes a risky shell action, runs the Guardian workflow, creates a checkpoint, persists workflow state, and returns `needs_user_approval` instead of executing the command.

For the live MCP test evidence, see [docs/live-mcp-test.md](docs/live-mcp-test.md).

---

## Project Docs

- [Live MCP test](docs/live-mcp-test.md)
- [Architecture](docs/architecture.md)

---

## Agent Instructions

To make another AI assistant use the Guardian workflow consistently, copy the relevant rules from [AGENTS.md.example](AGENTS.md.example) into that assistant's project rules file.

Recommended default:

```text
Before risky file edits, call guardian_run_workflow.
Proceed only when the workflow decision is ready.
If the edit goes wrong, call guardian_restore_workflow with the workflowId.
```

---

## Design Principles

- Local-first.
- On-demand only.
- Deterministic checks before LLM interpretation.
- Compact output by default.
- No background monitoring.
- No continuous event logging.
- Rollback before risky action.

---

## License

MIT. See [LICENSE](LICENSE).
