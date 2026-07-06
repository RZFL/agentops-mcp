# Agent Component Inspector

Read-only Windows-first scanner for AI agent add-ons and model-affecting
components.

It looks for:

- AI coding client, editor, and Claude Desktop config files.
- MCP server blocks in TOML/JSON configs.
- Model provider/base URL overrides.
- Agent-client plugin and hook blocks.
- AI-related VS Code/Cursor extensions.
- AI-related Windows processes, Docker containers, and installed apps.

It does not disable, delete, stop, or edit anything. Each finding includes
backup-first instructions for the model or human operator that will perform the
actual change.

## Run

GUI:

```powershell
py -3 .\agent_component_inspector.py
```

JSON for MCP or automation:

```powershell
py -3 .\agent_component_inspector.py --no-gui --json
```

Scan an extra project/config root:

```powershell
py -3 .\agent_component_inspector.py --no-gui --json --extra-root <workspace-root>
```

## MCP Shape

For an MCP tool, call `scan(...)` and return the list of findings as JSON. Keep
the tool read-only. A separate future tool can apply changes, but it should
require explicit user approval and a fresh timestamped backup.
