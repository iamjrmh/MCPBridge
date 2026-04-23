<div align="center">

# MCPBridge

**Connect Claude Code and Ollama to Roblox Studio via the Model Context Protocol**

[![Platform - Windows](https://img.shields.io/badge/platform-Windows-0078d4?logo=windows&logoColor=white)](https://github.com)
[![Platform - macOS](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)](https://github.com)
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

## ⚙️ Prerequisites - Required for Everyone

These steps are required regardless of your platform or install method.

### 1 - Download the source

Click **Code → Download ZIP** at the top of this page and extract it somewhere on your machine.

Then grab the installer for your platform from the [**Releases page**](https://github.com):

<table>
<tr>
<td align="center" width="50%">
<a href="https://github.com/iamjrmh/MCPBridge/releases/latest/download/MCPBridge.exe">
<img src="https://img.shields.io/badge/Download-MCPBridge.exe-0078d4?style=for-the-badge&logo=windows&logoColor=white" alt="Download MCPBridge.exe"/>
</a><br/>
<sub>Windows Installer</sub>
</td>
<td align="center" width="50%">
<a href="https://github.com/iamjrmh/MCPBridge/releases/latest/download/MCPBridge.pkg">
<img src="https://img.shields.io/badge/Download-MCPBridge.pkg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download MCPBridge.pkg"/>
</a><br/>
<sub>macOS Installer</sub>
</td>
</tr>
</table>

Place the installer in the same folder as the extracted source before continuing.

### 2 - Install Node.js via NVM

<details>
<summary><b>🪟 Windows</b></summary>

Download and run **`nvm-setup.exe`** from the [nvm-windows releases page](https://github.com/coreybutler/nvm-windows/releases), then open a new terminal and run:

```bash
nvm install lts
nvm use lts
```

This installs the latest Node.js LTS release and sets it as your active version.

</details>

<details>
<summary><b>🍎 macOS</b></summary>

Install [nvm](https://github.com/nvm-sh/nvm) by running the install script in your terminal:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Then restart your terminal (or run `source ~/.zshrc`), and run:

```bash
nvm install --lts
nvm use --lts
nvm alias default 'lts/*'
```

This installs the latest Node.js LTS release and sets it as your default.

</details>

### 3 - Install server dependencies

Navigate into the extracted folder and install dependencies:

```bash
cd roblox-ollama-mcp/mcp-server
npm install
```

> [!WARNING]
> Do not skip this step. Without it, the MCP server will not start and nothing will connect.

### 4 - Enable Studio as MCP Server

> [!IMPORTANT]
> To enable the MCP server in Studio:
> 1. Open **Assistant**
> 2. Click **... → Manage MCP Servers**
> 3. Turn on **Enable Studio as MCP server**

---

## 🚀 Quick Install

### 🪟 Windows <img src="https://img.shields.io/badge/Recommended-0078d4?logo=windows&logoColor=white" alt="Recommended" height="20"/>

1. Launch **`MCPBridge.exe`**
2. If `index.js` or `OllamaMCP.lua` weren't auto-detected, press **Browse** and select them manually - paths are saved automatically
3. Exit MCPBridge, then launch Claude Code via Ollama:
   ```bash
   ollama launch claude --model minimax-m2.5:cloud
   ```
4. Start giving Claude prompts for your Roblox game and watch it build!

### 🍎 macOS <img src="https://img.shields.io/badge/Recommended-000000?logo=apple&logoColor=white" alt="Recommended" height="20"/>

> [!NOTE]
> On first launch macOS may show a security warning. Go to **System Settings → Privacy & Security** and click **Open Anyway** to allow it.

1. Launch **`MCPBridge.pkg`**
2. If `index.js` or `OllamaMCP.lua` weren't auto-detected, press **Browse** and select them manually - paths are saved automatically
3. Exit MCPBridge, then launch Claude Code via Ollama:
   ```bash
   ollama launch claude --model minimax-m2.5:cloud
   ```
4. Start giving Claude prompts for your Roblox game and watch it build!

---

## 📦 Manual Setup

### 1 - Configure Claude Code

Add the MCP server to Claude Code's config. The config file lives at:

| OS      | Path                           |
|---------|-------------------------------|
| macOS   | `~/.claude.json`               |
| Windows | `%USERPROFILE%\.claude.json`  |

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

### 2 - Install the Roblox Studio Plugin

1. Open Roblox Studio
2. Go to **Plugins → Plugin Folder** (opens a folder in your file explorer)
3. Copy `roblox-plugin/OllamaMCP.lua` into that folder
4. Restart Roblox Studio
5. The **"MCP Bridge"** button appears in the Plugins toolbar

> [!IMPORTANT]
> To enable the MCP server in Studio:
> 1. Open **Assistant**
> 2. Click **... → Manage MCP Servers**
> 3. Turn on **Enable Studio as MCP server**

### 3 - Start Ollama

Pick a model and launch it with Ollama. The bridge calls the REST API at `http://localhost:11434` automatically.

**Recommended models:**

```bash
# Balanced cloud model (default)
ollama launch claude --model minimax-m2.5:cloud

# Newer cloud model
ollama launch claude --model minimax-m2.7:cloud

# General purpose
ollama launch claude --model qwen3.5

# Coding focused
ollama launch claude --model qwen3-coder

# Lightweight / fast
ollama launch claude --model gemma4
```

### 4 - Connect everything

1. In Roblox Studio, click **"MCP Bridge"** in the toolbar - widget shows 🟢 Connected
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

- The plugin may have been deactivated - click the toolbar button again
- Check the plugin widget for error messages

</details>

<details>
<summary><b>🍎 macOS - "App can't be opened" security warning</b></summary>

macOS may block the installer on first launch since it isn't notarized. To allow it:

1. Go to **System Settings → Privacy & Security**
2. Scroll down and click **Open Anyway** next to MCPBridge
3. Confirm in the dialog that appears

Alternatively, right-click the `.pkg` and choose **Open** to bypass the warning directly.

</details>

<details>
<summary><b>🍎 macOS - mcp-server or roblox-plugin folder not found</b></summary>

On first launch, MCPBridge automatically extracts these folders next to the `.pkg`. If auto-detection still fails, use the **Browse** button in the app to point to them manually. The folders will be located next to `MCPBridge.pkg` in the same directory.

</details>

---

## 📁 File Structure

```
roblox-ollama-mcp/
├── mcp-server/
│   ├── index.js               ← MCP + HTTP bridge server
│   └── package.json
├── roblox-plugin/
│   └── OllamaMCP.lua          ← Studio plugin (auto-installed on Windows & macOS)
├── MCPBridge.py               ← Installer source
├── MCPBridge.exe              ← Windows installer (double-click to run)
├── MCPBridge.pkg              ← macOS installer (double-click to run)
├── build.bat                  ← Windows build script
├── build.sh                   ← macOS build script
├── claude_mcp_config.json     ← Example Claude Code config snippet
├── start.sh                   ← Helper startup script
└── README.md
```
