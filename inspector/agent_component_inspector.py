#!/usr/bin/env python3
"""
Read-only inspector for AI agent add-ons on Windows.

It finds MCP servers, model/provider overrides, plugins, extensions, processes,
containers, and known AI tooling footprints. It does not disable anything.
The output is meant for a human GUI or for a future MCP tool that gives a model
backup-first instructions before it changes the environment.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None


KEYWORDS = re.compile(
    r"\bai\b|agent|anthropic|cline|continue|copilot|cursor|headroom|"
    r"\bllm\b|\bmcp\b|model|ollama|openai|provider|roo|tabnine|zed",
    re.IGNORECASE,
)
APP_KEYWORDS = re.compile(
    r"antigravity|aider|anthropic|cline|codeium|continue|copilot|cursor|"
    r"headroom|lm studio|\bmcp\b|ollama|openai|qdrant|roo|tabnine|zed",
    re.IGNORECASE,
)
PLUGIN_RISK_KEYWORDS = re.compile(
    r"agent|browser|headroom|\bmcp\b|model|pony|provider", re.IGNORECASE
)


@dataclass(frozen=True)
class Finding:
    host: str
    name: str
    kind: str
    status: str
    risk: str
    path: str
    evidence: str
    instruction: str


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""


def read_json(path: Path) -> Any | None:
    text = read_text(path)
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def backup_instruction(path: str) -> str:
    return (
        "Before changing anything:\n"
        f"1. Create a timestamped backup of {path}.\n"
        "2. Change the smallest config block that owns this component.\n"
        "3. Restart the host application so it reloads tools/plugins/providers.\n"
        "4. If behavior gets worse, restore the backup and restart again."
    )


def config_instruction(path: str, host: str, component: str, hint: str) -> str:
    return (
        f"{backup_instruction(path)}\n\n"
        f"Suggested action for {host} / {component}:\n"
        f"{hint}\n\n"
        "Model guidance:\n"
        "- Do not delete or uninstall first.\n"
        f"- Read the exact config block from {path!r} before editing.\n"
        "- Prefer an explicit enabled=false or disabled=true flag when supported.\n"
        "- If the component is unknown, gather nearby config, docs, processes, "
        "and extension info before deciding."
    )


def host_from_path(path: Path) -> str:
    low = str(path).lower()
    if "\\.ai-client\\" in low or "/.ai-client/" in low:
        return "AI coding client"
    if "\\cursor\\" in low or "\\.cursor\\" in low or "/cursor/" in low:
        return "Cursor"
    if "\\code\\" in low or "\\.vscode\\" in low or "/code/" in low:
        return "VS Code"
    if "\\antigravity\\" in low or "\\.antigravity\\" in low:
        return "Antigravity"
    if "\\zed\\" in low or "\\.zed\\" in low:
        return "Zed"
    if "claude" in low:
        return "Claude Desktop"
    return "Unknown"


def add_toml_findings(path: Path) -> list[Finding]:
    text = read_text(path)
    if not text:
        return []

    host = host_from_path(path)
    findings: list[Finding] = []

    active_provider = re.search(r'(?m)^\s*model_provider\s*=\s*"([^"]+)"', text)
    active_base_url = re.search(r'(?m)^\s*openai_base_url\s*=\s*"([^"]+)"', text)
    if active_provider or active_base_url:
        name = active_provider.group(1) if active_provider else "custom-base-url"
        evidence = "; ".join(
            x.group(0).strip() for x in (active_provider, active_base_url) if x
        )
        findings.append(
            Finding(
                host,
                name,
                "model-provider-active",
                "enabled",
                "high",
                str(path),
                evidence,
                config_instruction(
                    str(path),
                    host,
                    name,
                    "Comment top-level model_provider/openai_base_url lines or "
                    "switch model_provider back to the default provider.",
                ),
            )
        )

    for match in re.finditer(
        r"(?ms)^\s*\[mcp_servers\.([^\]\r\n]+)\]\s*(.*?)(?=^\s*\[|\Z)", text
    ):
        raw_name = match.group(1).strip()
        if ".env" in raw_name or ".tools." in raw_name:
            continue
        name = raw_name.strip('"')
        body = match.group(2)
        disabled = bool(re.search(r"(?m)^\s*enabled\s*=\s*false\s*$", body))
        command = re.search(r'(?m)^\s*command\s*=\s*["\']?([^"\'\r\n]+)', body)
        findings.append(
            Finding(
                host,
                name,
                "mcp-server",
                "disabled" if disabled else "enabled",
                "low" if disabled else "medium",
                str(path),
                f"command = {command.group(1).strip()}" if command else "mcp server block",
                config_instruction(
                    str(path),
                    host,
                    name,
                    f"Set enabled = false inside [mcp_servers.{name}]. "
                    "If the key is absent, add it inside that block.",
                ),
            )
        )

    for match in re.finditer(
        r'(?ms)^\s*\[plugins\."([^"]+)"\]\s*(.*?)(?=^\s*\[|\Z)', text
    ):
        name = match.group(1)
        body = match.group(2)
        disabled = bool(re.search(r"(?m)^\s*enabled\s*=\s*false\s*$", body))
        findings.append(
            Finding(
                host,
                name,
                "plugin",
                "disabled" if disabled else "enabled",
                "low" if disabled else ("medium" if PLUGIN_RISK_KEYWORDS.search(name) else "low"),
                str(path),
                "plugin block",
                config_instruction(
                    str(path),
                    host,
                    name,
                    f'Set enabled = false inside [plugins."{name}"].',
                ),
            )
        )

    for match in re.finditer(r"(?m)^\s*\[model_providers\.([^\]\r\n]+)\]", text):
        name = match.group(1).strip('"')
        is_active = bool(active_provider and active_provider.group(1) == name)
        findings.append(
            Finding(
                host,
                name,
                "model-provider",
                "enabled" if is_active else "available",
                "high" if is_active else "info",
                str(path),
                "provider definition",
                config_instruction(
                    str(path),
                    host,
                    name,
                    f'This provider is active only when top-level model_provider = "{name}".',
                ),
            )
        )

    if re.search(r"(?m)^\s*\[hooks\.state\]|hooks/", text):
        findings.append(
            Finding(
                host,
                "configured hooks",
                "hook-state",
                "available",
                "medium",
                str(path),
                "hooks.state or hook path present",
                config_instruction(
                    str(path),
                    host,
                    "configured hooks",
                    "Inspect plugin settings first. Disable the owning plugin and restart. "
                    "Do not edit trusted hash state unless host docs require it.",
                ),
            )
        )

    return findings


def add_mcp_json_findings(path: Path) -> list[Finding]:
    data = read_json(path)
    if not isinstance(data, dict):
        return []
    host = host_from_path(path)
    servers = (
        data.get("mcpServers")
        or data.get("servers")
        or data.get("context_servers")
        or (data.get("mcp") or {}).get("servers")
    )
    if not isinstance(servers, dict):
        return []

    findings: list[Finding] = []
    for name, value in servers.items():
        if not isinstance(value, dict):
            value = {}
        disabled = bool(value.get("disabled", False))
        if "enabled" in value:
            disabled = not bool(value.get("enabled"))
        command = value.get("command") or value.get("url") or "json-defined server"
        findings.append(
            Finding(
                host,
                str(name),
                "mcp-server",
                "disabled" if disabled else "enabled",
                "low" if disabled else "medium",
                str(path),
                f"command/url = {command}",
                config_instruction(
                    str(path),
                    host,
                    str(name),
                    "Set enabled=false or disabled=true if the host supports it. "
                    "Otherwise remove only this JSON property after backup.",
                ),
            )
        )
    return findings


def walk_json_keys(value: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            name = f"{prefix}.{key}" if prefix else str(key)
            yield name, child
            yield from walk_json_keys(child, name)
    elif isinstance(value, list):
        for index, child in enumerate(value[:50]):
            yield from walk_json_keys(child, f"{prefix}[{index}]")


def add_settings_findings(path: Path) -> list[Finding]:
    data = read_json(path)
    if data is None:
        return []
    host = host_from_path(path)
    findings: list[Finding] = []
    seen: set[str] = set()
    for key, value in walk_json_keys(data):
        line = f"{key} = {value!r}"
        if KEYWORDS.search(line):
            bucket = "mcp-config" if "mcp" in line.lower() else "model-or-agent-config"
            if bucket in seen:
                continue
            seen.add(bucket)
            findings.append(
                Finding(
                    host,
                    bucket,
                    bucket,
                    "available",
                    "medium",
                    str(path),
                    key,
                    config_instruction(
                        str(path),
                        host,
                        bucket,
                        "Read the matching setting keys and disable only the "
                        "extension/provider/server key that owns the behavior.",
                    ),
                )
            )
    return findings


def known_config_paths(extra_roots: list[Path]) -> list[Path]:
    home = Path.home()
    appdata = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
    local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))

    fixed = [
        home / ".cursor" / "mcp.json",
        home / ".cursor" / "settings.json",
        appdata / "Cursor" / "User" / "mcp.json",
        appdata / "Cursor" / "User" / "settings.json",
        appdata / "Code" / "User" / "mcp.json",
        appdata / "Code" / "User" / "settings.json",
        appdata / "Antigravity" / "User" / "mcp.json",
        appdata / "Antigravity" / "User" / "settings.json",
        appdata / "Zed" / "settings.json",
        home / ".antigravity" / "config.toml",
        home / ".antigravity" / "mcp.json",
        home / ".config" / "zed" / "settings.json",
        home / ".config" / "zed" / "mcp.json",
        appdata / "Claude" / "claude_desktop_config.json",
    ]

    results = [p for p in fixed if p.is_file()]
    roots = [
        home / ".cursor",
        home / ".vscode",
        home / ".antigravity",
        home / ".config" / "zed",
        appdata / "Code" / "User",
        appdata / "Cursor" / "User",
        appdata / "Antigravity" / "User",
        appdata / "Zed",
        *extra_roots,
    ]
    names = {"mcp.json", "settings.json", "config.toml", "claude_desktop_config.json"}
    for root in roots:
        if not root.is_dir():
            continue
        try:
            for path in root.rglob("*"):
                if path.is_file() and path.name in names:
                    results.append(path)
        except OSError:
            continue

    return sorted(set(results), key=lambda p: str(p).lower())


def extension_findings() -> list[Finding]:
    home = Path.home()
    dirs = [
        ("VS Code", home / ".vscode" / "extensions"),
        ("Cursor", home / ".cursor" / "extensions"),
    ]
    findings: list[Finding] = []
    for host, root in dirs:
        if not root.is_dir():
            continue
        try:
            children = [p for p in root.iterdir() if p.is_dir()]
        except OSError:
            continue
        for child in children:
            if APP_KEYWORDS.search(child.name):
                findings.append(
                    Finding(
                        host,
                        child.name,
                        "extension",
                        "installed",
                        "medium",
                        str(child),
                        "extension directory",
                        "Disable through the host extension manager or CLI after "
                        "backing up settings. Prefer disabling over deleting files.",
                    )
                )
    return findings


def process_findings() -> list[Finding]:
    if os.name != "nt":
        return []
    try:
        out = subprocess.run(
            ["tasklist", "/fo", "csv", "/nh"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []

    findings: list[Finding] = []
    for row in csv.reader(out.splitlines()):
        if not row:
            continue
        name = row[0]
        if APP_KEYWORDS.search(name) or name.lower() in {"code.exe", "cursor.exe"}:
            findings.append(
                Finding(
                    "Windows",
                    name,
                    "process",
                    "running",
                    "info",
                    "tasklist",
                    f"pid = {row[1] if len(row) > 1 else '?'}",
                    "Process discovery only. Do not kill first. Find the owning "
                    "config/plugin/autostart entry, back it up, disable there, "
                    "then restart the host and verify the process stays stopped.",
                )
            )
    return dedupe(findings)


def docker_findings() -> list[Finding]:
    try:
        out = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}|{{.Image}}|{{.Status}}"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []

    findings: list[Finding] = []
    for line in out.splitlines():
        parts = line.split("|", 2)
        if len(parts) != 3:
            continue
        name, image, status = parts
        if not APP_KEYWORDS.search(f"{name} {image}"):
            continue
        findings.append(
            Finding(
                "Docker",
                name,
                "container",
                "running",
                "medium",
                f"docker:{name}",
                f"{image}; {status}",
                "Before stopping this container, identify its compose file or "
                "run command and back that up. Prefer changing the compose "
                "profile/config that starts it; stop the container only after that.",
            )
        )
    return findings


def registry_findings() -> list[Finding]:
    if os.name != "nt":
        return []
    try:
        import winreg
    except ImportError:
        return []

    roots = [
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    findings: list[Finding] = []
    for hive, subkey in roots:
        try:
            with winreg.OpenKey(hive, subkey) as key:
                count = winreg.QueryInfoKey(key)[0]
                for index in range(count):
                    try:
                        child_name = winreg.EnumKey(key, index)
                        with winreg.OpenKey(key, child_name) as child:
                            display, _ = winreg.QueryValueEx(child, "DisplayName")
                    except OSError:
                        continue
                    if display and APP_KEYWORDS.search(str(display)):
                        findings.append(
                            Finding(
                                "Windows",
                                str(display),
                                "installed-app",
                                "installed",
                                "info",
                                f"registry:{subkey}\\{child_name}",
                                "Windows uninstall registry",
                                "Installed software discovery only. Do not uninstall "
                                "first; inspect app-specific config, extensions, MCP "
                                "servers, and processes before changing anything.",
                            )
                        )
        except OSError:
            continue
    return dedupe(findings)


def dedupe(findings: Iterable[Finding]) -> list[Finding]:
    seen: set[tuple[str, str, str, str]] = set()
    result: list[Finding] = []
    for item in findings:
        key = (item.host, item.name, item.kind, item.path)
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result


def scan(extra_roots: list[Path]) -> list[Finding]:
    findings: list[Finding] = []
    for path in known_config_paths(extra_roots):
        lower = path.name.lower()
        if lower.endswith(".toml"):
            findings.extend(add_toml_findings(path))
        elif lower in {"mcp.json", "claude_desktop_config.json"}:
            findings.extend(add_mcp_json_findings(path))
            findings.extend(add_settings_findings(path))
        elif lower.endswith(".json"):
            findings.extend(add_settings_findings(path))

    findings.extend(extension_findings())
    findings.extend(process_findings())
    findings.extend(docker_findings())
    findings.extend(registry_findings())

    order = {"high": 0, "medium": 1, "low": 2, "info": 3}
    return sorted(
        dedupe(findings),
        key=lambda f: (order.get(f.risk, 9), f.host.lower(), f.kind, f.name.lower()),
    )


def show_gui(findings: list[Finding]) -> None:
    import tkinter as tk
    from tkinter import ttk

    root = tk.Tk()
    root.title("Agent Component Inspector")
    root.geometry("1280x820")

    columns = ("host", "name", "kind", "status", "risk", "path", "evidence")
    tree = ttk.Treeview(root, columns=columns, show="headings", height=20)
    for column in columns:
        tree.heading(column, text=column.title())
        tree.column(column, width=150 if column != "path" else 360, anchor="w")

    tree.tag_configure("high", background="#ffe1e1")
    tree.tag_configure("medium", background="#fff6cc")
    tree.tag_configure("low", background="#e8ffe8")
    tree.tag_configure("info", background="#e8f2ff")

    index_by_iid: dict[str, Finding] = {}
    for index, item in enumerate(findings):
        iid = str(index)
        index_by_iid[iid] = item
        tree.insert(
            "",
            "end",
            iid=iid,
            values=(
                item.host,
                item.name,
                item.kind,
                item.status,
                item.risk,
                item.path,
                item.evidence,
            ),
            tags=(item.risk,),
        )

    details = tk.Text(root, wrap="word", height=16)
    details.insert(
        "1.0",
        "Select a row to see backup-first disable instructions. "
        "This tool is read-only.\n",
    )
    details.configure(state="disabled")

    def on_select(_: object) -> None:
        selected = tree.selection()
        if not selected:
            return
        item = index_by_iid[selected[0]]
        text = (
            f"Host: {item.host}\n"
            f"Name: {item.name}\n"
            f"Kind: {item.kind}\n"
            f"Status: {item.status}\n"
            f"Risk: {item.risk}\n"
            f"Path: {item.path}\n"
            f"Evidence: {item.evidence}\n\n"
            f"{item.instruction}\n"
        )
        details.configure(state="normal")
        details.delete("1.0", "end")
        details.insert("1.0", text)
        details.configure(state="disabled")

    tree.bind("<<TreeviewSelect>>", on_select)

    legend = ttk.Label(
        root,
        text=(
            "Read-only scan. Red = active model/proxy, yellow = tool/plugin/"
            "container, green = disabled/low, blue = informational."
        ),
    )

    tree.pack(fill="both", expand=True, padx=8, pady=(8, 4))
    details.pack(fill="both", expand=False, padx=8, pady=4)
    legend.pack(fill="x", padx=8, pady=(0, 8))
    root.mainloop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only AI agent component inspector")
    parser.add_argument("--json", action="store_true", help="print JSON findings")
    parser.add_argument("--no-gui", action="store_true", help="do not open Tk GUI")
    parser.add_argument(
        "--extra-root",
        action="append",
        default=[],
        help="additional directory to scan for config.toml/mcp.json/settings.json",
    )
    args = parser.parse_args(argv)

    findings = scan([Path(p).expanduser() for p in args.extra_root])
    if args.json:
        print(json.dumps([asdict(f) for f in findings], ensure_ascii=False, indent=2))
    if not args.no_gui:
        show_gui(findings)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
