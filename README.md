<div align="center">

# 🎮 Roblox Ollama MCP Bridge

**Connect Claude Code and Ollama to Roblox Studio via the Model Context Protocol**

[![Platform - Windows](https://img.shields.io/badge/platform-Windows-0078d4?logo=windows&logoColor=white)](https://github.com)
[![Platform - macOS](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)](https://github.com)
[![Platform - Linux](https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black)](https://github.com)
[![Node.js - v22 LTS](https://img.shields.io/badge/Node.js-v22_LTS-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Ollama](https://img.shields.io/badge/Ollama-minimax--m2.5:cloud-black?logo=ollama&logoColor=white)](https://ollama.com)
[![MCP](https://img.shields.io/badge/Protocol-MCP-blueviolet)](https://modelcontextprotocol.io)

</div>

---

```
Claude Code (stdio)
      │ MCP protocol
      ▼
  MCP Server ──── HTTP :7842 ───► Roblox Studio Plugin (Lua)
      │
      └── Ollama API (:11434) ──► minimax-m2.5:cloud
```

---

## 🚀 Quick Install <img src="https://img.shields.io/badge/Windows-Recommended-0078d4?logo=windows&logoColor=white" alt="Windows Recommended" height="20"/>

**MCPBridge.exe handles everything automatically** — no manual config editing or file copying required.

1. Download `MCPBridge.exe` from the [latest release](../../releases/latest)
2. Run it and follow the on-screen instructions

> [!NOTE]
> Make sure Roblox Studio has been installed at least once before running the installer so the Plugins folder can be located automatically.

> [!TIP]
> **Linux & macOS users:** The `.exe` installer is Windows-only. Please follow the [Manual Setup](#-manual-setup) section below to move the required files yourself.

---

## 📦 Manual Setup

### 1 — Install dependencies

```bash
cd mcp-server
npm install
```

### 2 — Configure Claude Code

Add the MCP server to Claude Code's config. The config file lives at:

| OS      | Path                           |
|---------|-------------------------------|
| macOS   | `~/.claude.json`               |
| Windows | `%USERPROFILE%\.claude.json`  |
| Linux   | `~/.claude.json`               |

Add or merge this block (replace the path with your actual path):

```json
{
  "mcpServers": {
    "roblox-ollama": {
      "command": "node",
      "args": ["/absolute/path/to/roblox-ollama-mcp/mcp-server/index.js"]
    }
  }
}
```

Then restart Claude Code. You should see `roblox-ollama` in your MCP tools list.

### 3 — Install the Roblox Studio Plugin

1. Open Roblox Studio
2. Go to **Plugins → Plugin Folder** (opens a folder in your file explorer)
3. Copy `roblox-plugin/OllamaMCP.lua` into that folder
4. Restart Roblox Studio
5. The **"MCP Bridge"** button appears in the Plugins toolbar

> [!IMPORTANT]
> Enable HTTP requests in Studio: **File → Studio Settings → Studio → Allow HTTP Requests** ✓

### 4 — Start Ollama

```bash
ollama launch claude --model minimax-m2.5:cloud
```

The bridge calls Ollama's REST API at `http://localhost:11434` automatically.

### 5 — Connect everything

1. In Roblox Studio, click **"MCP Bridge"** in the toolbar → widget shows 🟢 Connected
2. Open Claude Code in your terminal
3. Start asking Claude to work on your Roblox scripts!

---

## 🛠 Available MCP Tools

### Studio Tools

| Tool | Description |
|------|-------------|
| `studio_status` | Check if plugin is connected |
| `studio_list_scripts` | List all scripts in the place |
| `studio_read_script` | Read a script's source code |
| `studio_write_script` | Overwrite a script's source |
| `studio_create_script` | Create a new script instance |
| `studio_execute_lua` | Execute Lua in the plugin context |
| `studio_get_output` | Get recent print/warn output |
| `studio_get_workspace_info` | Get place metadata |
| `studio_get_selection` | Get currently selected instances |

### Ollama Tools

| Tool | Description |
|------|-------------|
| `ollama_generate` | Raw prompt → completion |
| `ollama_generate_lua` | Generate Roblox Lua for a task, optionally write to Studio |
| `ollama_review_script` | Review a script for bugs and performance issues |

---

## 💬 Example Prompts

```
"List all scripts in my Roblox game"

"Read the source of game.ServerScriptService.GameManager"

"Generate a Roblox Lua leaderboard system and write it to game.ServerScriptService.Leaderboard"

"Review game.StarterPlayer.StarterCharacterScripts.Movement for performance issues"

"Create a new LocalScript called 'UIHandler' in game.StarterPlayer.StarterPlayerScripts"
```

---

## 🔧 Troubleshooting

<details>
<summary><b>Plugin shows 🔴 Disconnected</b></summary>

- Make sure the MCP server is running (Claude Code must have it active)
- Confirm HTTP requests are enabled in Studio Settings
- Check that port `7842` isn't blocked by a firewall

</details>

<details>
<summary><b>Ollama errors</b></summary>

- Confirm Ollama is running: `curl http://localhost:11434/api/tags`
- Make sure `minimax-m2.5:cloud` is available in your Ollama setup

</details>

<details>
<summary><b>"Command timed out"</b></summary>

- The plugin may have been deactivated — click the toolbar button again
- Check the plugin widget for error messages

</details>

---

## 📁 File Structure

```
roblox-ollama-mcp/
├── mcp-server/
│   ├── index.js               ← MCP + HTTP bridge server
│   └── package.json
├── roblox-plugin/
│   └── OllamaMCP.lua          ← Studio plugin (auto-installed on Windows)
├── install_mcp.py             ← Installer source
├── MCPBridge.exe              ← Windows installer (double-click to run)
├── claude_mcp_config.json     ← Example Claude Code config snippet
├── start.sh                   ← Helper startup script
└── README.md
```
