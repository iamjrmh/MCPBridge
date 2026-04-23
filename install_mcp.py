"""
Roblox Ollama MCP Installer
----------------------------
Drag and drop your index.js to automatically:
  1. Configure Claude Code's .claude.json
  2. Install OllamaMCP.lua into Roblox Studio's plugin folder
"""

import json
import os
import platform
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional


# ── Resize console window ──────────────────────────────────────────
def set_window_size(cols, lines):
    if platform.system() == "Windows":
        os.system("mode con: cols={} lines={}".format(cols, lines))


# ── Colors (work on Windows 10+ and all Unix) ─────────────────────
def supports_color():
    return platform.system() != "Windows" or "ANSICON" in os.environ or "WT_SESSION" in os.environ

RESET  = "\033[0m"  if supports_color() else ""
BOLD   = "\033[1m"  if supports_color() else ""
GREEN  = "\033[92m" if supports_color() else ""
YELLOW = "\033[93m" if supports_color() else ""
RED    = "\033[91m" if supports_color() else ""
CYAN   = "\033[96m" if supports_color() else ""
DIM    = "\033[2m"  if supports_color() else ""


def banner():
    print(f"""
{CYAN}{BOLD}╔══════════════════════════════════════════════════╗
║      Roblox Ollama MCP  —  Claude Code Setup     ║
╚══════════════════════════════════════════════════╝{RESET}
""")


def ok(msg):   print(f"  {GREEN}checkmark{RESET}  {msg}".replace("checkmark", "✔"))
def warn(msg): print(f"  {YELLOW}!{RESET}  {msg}")
def err(msg):  print(f"  {RED}X{RESET}  {msg}")
def info(msg): print(f"  {CYAN}>{RESET}  {msg}")
def dim(msg):  print(f"  {DIM}{msg}{RESET}")
def sep():     print(f"  {DIM}{'─' * 48}{RESET}")


# ── Pause before exit ─────────────────────────────────────────────
def pause_and_exit(code=0):
    print()
    input("  Press Enter to close...")
    sys.exit(code)


# ── Clean up a drag-and-dropped path ──────────────────────────────
def clean_path(raw):
    raw = raw.strip().strip("'\"")
    raw = raw.replace("\\", "/")
    return raw


# ── Find .claude.json ─────────────────────────────────────────────
def find_claude_json():
    return Path.home() / ".claude.json"


# ── Find Roblox Studio plugin folder ─────────────────────────────
def find_roblox_plugin_folder():
    system = platform.system()

    if system == "Windows":
        local_app = os.environ.get("LOCALAPPDATA", "")
        if local_app:
            candidate = Path(local_app) / "Roblox" / "Plugins"
            if candidate.parent.exists():
                return candidate
        candidate = Path.home() / "AppData" / "Local" / "Roblox" / "Plugins"
        if candidate.parent.exists():
            return candidate

    elif system == "Darwin":
        candidate = Path.home() / "Library" / "Application Support" / "Roblox" / "Plugins"
        if candidate.parent.exists():
            return candidate

    elif system == "Linux":
        user = os.environ.get("USER", "")
        candidates = [
            Path.home() / ".local" / "share" / "roblox" / "Plugins",
            Path.home() / ".wine" / "drive_c" / "users" / user / "AppData" / "Local" / "Roblox" / "Plugins",
        ]
        for p in candidates:
            if p.parent.exists():
                return p

    return None


# ── Find OllamaMCP.lua relative to index.js ──────────────────────
def find_plugin_lua(index_js):
    # index.js is in mcp-server/, plugin is in sibling roblox-plugin/
    candidate = index_js.parent.parent / "roblox-plugin" / "OllamaMCP.lua"
    if candidate.exists():
        return candidate
    # Fallback: same directory
    candidate2 = index_js.parent / "OllamaMCP.lua"
    if candidate2.exists():
        return candidate2
    return None


# ── Load .claude.json ─────────────────────────────────────────────
def load_claude_json(path):
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except json.JSONDecodeError as e:
            err("Your .claude.json has invalid JSON: {}".format(e))
            err("Cannot safely modify it. Please fix it first.")
            pause_and_exit(1)
    return {}


def save_claude_json(path, data):
    if path.exists():
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = path.parent / (".claude.backup_{}.json".format(ts))
        shutil.copy2(path, backup)
        dim("Backup saved -> {}".format(backup))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# ── Plugin folder hint ────────────────────────────────────────────
def print_plugin_folder_hint():
    system = platform.system()
    if system == "Windows":
        dim("  Windows: %LOCALAPPDATA%\\Roblox\\Plugins\\")
    elif system == "Darwin":
        dim("  macOS:   ~/Library/Application Support/Roblox/Plugins/")
    else:
        dim("  Linux:   ~/.local/share/roblox/Plugins/")
    print()
    dim("  Or in Roblox Studio: Plugins menu -> Plugin Folder")


# ── Main ──────────────────────────────────────────────────────────
def main():
    set_window_size(72, 12)
    banner()

    # ── Locate .claude.json ───────────────────────────────────────
    claude_json_path = find_claude_json()
    info("Claude config : {}".format(claude_json_path))
    if claude_json_path.exists():
        ok("Found existing .claude.json")
    else:
        warn(".claude.json not found — a new one will be created")

    print()
    sep()
    print()

    # ── Get index.js path ─────────────────────────────────────────
    print("  {}Step 1 — Point to index.js{}".format(BOLD, RESET))
    print()
    print("  Drag and drop your {}index.js{} into this window and press Enter:".format(CYAN, RESET))
    dim("  (roblox-ollama-mcp/mcp-server/index.js)")
    print()

    try:
        raw_input = input("  > ").strip()
    except (KeyboardInterrupt, EOFError):
        print()
        warn("Cancelled.")
        pause_and_exit(0)

    if not raw_input:
        err("No path entered.")
        pause_and_exit(1)

    index_js_str = clean_path(raw_input)
    index_js = Path(index_js_str)

    if not index_js.exists():
        err("File not found: {}".format(index_js_str))
        pause_and_exit(1)

    if index_js.name != "index.js":
        warn("Expected 'index.js' but got '{}' — continuing anyway".format(index_js.name))

    ok("Path: {}".format(index_js_str))
    print()

    # ── Update .claude.json ───────────────────────────────────────
    sep()
    print()
    print("  {}Step 2 — Updating .claude.json{}".format(BOLD, RESET))
    print()

    data = load_claude_json(claude_json_path)
    existing = data.get("mcpServers", {}).get("roblox-ollama")

    do_write = True
    if existing:
        old_path = existing.get("args", ["(unknown)"])[0]
        warn("Existing 'roblox-ollama' entry found:")
        dim("  {}".format(old_path))
        print()
        try:
            answer = input("  Overwrite it? [{}y{}/n]: ".format(BOLD, RESET)).strip().lower()
        except (KeyboardInterrupt, EOFError):
            print()
            warn("Cancelled.")
            pause_and_exit(0)
        do_write = answer in ("", "y", "yes")

    if do_write:
        if "mcpServers" not in data:
            data["mcpServers"] = {}
        data["mcpServers"]["roblox-ollama"] = {
            "command": "node",
            "args": [index_js_str]
        }
        save_claude_json(claude_json_path, data)
        ok(".claude.json updated")
    else:
        warn("Skipped .claude.json update.")

    # ── Install Roblox plugin ─────────────────────────────────────
    print()
    sep()
    print()
    print("  {}Step 3 — Installing Roblox Studio plugin{}".format(BOLD, RESET))
    print()

    plugin_src = find_plugin_lua(index_js)

    if not plugin_src:
        warn("Could not find OllamaMCP.lua")
        warn("Expected at: roblox-ollama-mcp/roblox-plugin/OllamaMCP.lua")
        print()
        dim("Copy it manually to your Roblox Studio plugin folder, then restart Studio.")
        print_plugin_folder_hint()
    else:
        ok("Found plugin file: {}".format(plugin_src.name))

        plugin_folder = find_roblox_plugin_folder()

        if not plugin_folder:
            warn("Could not auto-detect your Roblox Studio plugin folder.")
            print()
            dim("Copy this file manually:")
            dim("  {}".format(plugin_src))
            dim("  -> into your Roblox Plugins folder, then restart Studio.")
            print()
            print_plugin_folder_hint()
        else:
            plugin_folder.mkdir(parents=True, exist_ok=True)
            dest = plugin_folder / "OllamaMCP.lua"

            if dest.exists():
                warn("OllamaMCP.lua already exists — overwriting")

            shutil.copy2(plugin_src, dest)
            ok("Plugin installed -> {}".format(dest))
            dim("Restart Roblox Studio to see the 'MCP Bridge' button.")

    # ── Done ──────────────────────────────────────────────────────
    print()
    sep()
    print()
    print("  {}{}Setup complete!{}".format(GREEN, BOLD, RESET))
    print()
    print("  {}Next steps:{}".format(BOLD, RESET))
    print("  1. Make sure Ollama is running")
    dim("     ollama launch claude --model minimax-m2.5:cloud")
    print("  2. {}Restart Claude Code{}".format(BOLD, RESET))
    print("  3. Open Roblox Studio — click the {}MCP Bridge{} button in Plugins".format(CYAN, RESET))
    print("  4. Ask Claude Code to work on your scripts!")
    print()

    pause_and_exit(0)


if __name__ == "__main__":
    main()
