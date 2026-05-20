<div align="center">

# MCPBridge

**Connect Claude Code and Ollama to Roblox Studio and Blender via the Model Context Protocol**

[![Platform - Windows](https://img.shields.io/badge/platform-Windows-0078d4?logo=windows&logoColor=white)](https://github.com)
[![Platform - macOS](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)](https://github.com)
[![Node.js - v22 LTS](https://img.shields.io/badge/Node.js-v22_LTS-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Ollama](https://img.shields.io/badge/Ollama-minimax--m2.5:cloud-black?logo=ollama&logoColor=white)](https://ollama.com)
[![MCP](https://img.shields.io/badge/Protocol-MCP-blueviolet)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/@iamjrmh/mcpbridge?logo=npm&color=cb3837)](https://www.npmjs.com/package/@iamjrmh/mcpbridge)

[![MCP Badge](https://lobehub.com/badge/mcp-full/iamjrmh-mcpbridge?theme=light)](https://lobehub.com/mcp/iamjrmh-mcpbridge)

</div>

---

```
Claude Code (stdio)
      │ MCP protocol
      ▼
  MCP Server ──── HTTP :7842 ───► Roblox Studio Plugin (Lua)
      │
      ├──── HTTP :7843 ───► Blender Plugin (Python)
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
cd MCPBridge/mcp-server
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

<details>
<summary><b>🪟 Windows</b> <img src="https://img.shields.io/badge/Recommended-0078d4?logo=windows&logoColor=white" alt="Recommended" height="20"/></summary>

1. Launch **`MCPBridge.exe`**
2. If `index.js` or `OllamaMCP.lua` weren't auto-detected, press **Browse** and select them manually
3. Click **Apply Changes** - this writes a single `mcpbridge` entry to your `claude.json` and installs the Roblox plugin automatically
4. **Roblox Studio:** click **Launch Studio** in the app, or open it manually
5. **Blender:** select your install from the dropdown and click **Launch Blender**, then install the addon once (see [Blender Plugin Setup](#blender-plugin-setup))
6. Exit MCPBridge, then launch Claude Code via Ollama:
   ```bash
   ollama launch claude --model minimax-m2.5:cloud
   ```
7. Start giving Claude prompts and watch it work!

</details>

<details>
<summary><b>🍎 macOS</b> <img src="https://img.shields.io/badge/Recommended-000000?logo=apple&logoColor=white" alt="Recommended" height="20"/></summary>

> [!NOTE]
> On first launch macOS may show a security warning. Go to **System Settings → Privacy & Security** and click **Open Anyway** to allow it.

1. Launch **`MCPBridge.pkg`**
2. If `index.js` or `OllamaMCP.lua` weren't auto-detected, press **Browse** and select them manually
3. Click **Apply Changes** - this writes a single `mcpbridge` entry to your `claude.json` and installs the Roblox plugin automatically
4. **Roblox Studio:** click **Launch Studio** in the app, or open it manually
5. **Blender:** select your install from the dropdown and click **Launch Blender**, then install the addon once (see [Blender Plugin Setup](#blender-plugin-setup))
6. Exit MCPBridge, then launch Claude Code via Ollama:
   ```bash
   ollama launch claude --model minimax-m2.5:cloud
   ```
7. Start giving Claude prompts and watch it work!

</details>

---

## 🔌 Blender Plugin Setup

The Blender plugin is installed manually once directly inside Blender. You only need to do this the first time.

1. Open Blender
2. Go to **Edit → Preferences → Add-ons**
3. Click **Install from Disk…**
4. Select `MCPBridge/blender-plugin/MCPBridge.py` from the extracted source folder
5. Enable **MCPBridge** in the add-ons list

Once enabled, open any **3D Viewport**, open the **Sidebar** (`N` key), go to the **MCPBridge** tab, and click **Start Bridge**. The status indicator will turn green when connected.

> [!NOTE]
> The Blender plugin connects to `localhost:7843`. Make sure the MCPBridge MCP server is running (i.e. Claude Code has it active) before clicking Start Bridge.

---

## 📦 Manual Setup

### 1 - Configure Claude Code

Add the MCP server to Claude Code's config. The config file lives at:

| OS      | Path                          |
|---------|-------------------------------|
| macOS   | `~/.claude.json`              |
| Windows | `%USERPROFILE%\.claude.json`  |

MCPBridge uses a **single unified server** that handles both Roblox and Blender. Add or merge one of the blocks below.

**Option A - from npm (recommended).** No source download or `npm install` is needed for the server; `npx` fetches and runs it:

```json
{
  "mcpServers": {
    "mcpbridge": {
      "command": "npx",
      "args": ["-y", "@iamjrmh/mcpbridge"]
    }
  }
}
```

**Option B - from local source.** Use this if you cloned the repo and want to run your own copy (replace the path with your actual path):

```json
{
  "mcpServers": {
    "mcpbridge": {
      "command": "node",
      "args": ["/absolute/path/to/MCPBridge/mcp-server/index.js"]
    }
  }
}
```

Then restart Claude Code. You should see `mcpbridge` in your MCP tools list with all Roblox and Blender tools available.

> [!NOTE]
> The npm package [`@iamjrmh/mcpbridge`](https://www.npmjs.com/package/@iamjrmh/mcpbridge) contains the MCP server only. You still need the source's `roblox-plugin/` and `blender-plugin/` files to install the Studio and Blender plugins.

> [!WARNING]
> If you have old `roblox-ollama` or `blender-mcp` entries in your `claude.json` from a previous version, remove them. Having multiple entries pointing at the same `index.js` will cause both to fail (port conflict on `:7842`). The MCPBridge app's **Apply Changes** button handles this migration automatically.

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

### 3 - Install the Blender Plugin

See [Blender Plugin Setup](#blender-plugin-setup) above.

### 4 - Start Ollama

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

### 5 - Connect everything

1. In Roblox Studio, click **"MCP Bridge"** in the toolbar - widget shows 🟢 Connected
2. In Blender, open the **MCPBridge** sidebar tab and click **Start Bridge** - status shows 🟢 Connected
3. Open Claude Code in your terminal
4. Start asking Claude to work on your Roblox scripts or Blender scene!

---

## 🛠 Available MCP Tools

### Studio Tools (Roblox)

| Tool | Description |
|------|-------------|
| `studio_status` | Check if the Roblox plugin is connected |
| `studio_list_scripts` | List all scripts in the place |
| `studio_read_script` | Read a script's source code |
| `studio_write_script` | Overwrite a script's source |
| `studio_create_script` | Create a new script instance |
| `studio_execute_lua` | Execute Lua in the plugin context |
| `studio_get_output` | Get recent print/warn output |
| `studio_get_workspace_info` | Get place metadata |
| `studio_get_selection` | Get currently selected instances |

### Blender Tools

| Tool | Description |
|------|-------------|
| `blender_status` | Check if the Blender plugin is connected |
| `blender_execute_python` | Execute Python (bpy) code in Blender |
| `blender_get_scene_info` | Get scene objects, active object, render settings |
| `blender_get_output` | Get recent output captured by the plugin |
| `ollama_generate_python` | Generate Blender Python for a task, optionally execute it |

### Ollama Tools

| Tool | Description |
|------|-------------|
| `ollama_generate` | Raw prompt → completion |
| `ollama_generate_lua` | Generate Roblox Lua for a task, optionally write to Studio |
| `ollama_review_script` | Review a script for bugs and performance issues |

### Prompts

Reusable, parameterised workflows exposed over MCP - invoke them from any MCP client.

| Prompt | Arguments | Purpose |
|--------|-----------|---------|
| `roblox_build_feature` | `feature`, `location?` | Plan and implement a Roblox feature end-to-end |
| `roblox_debug_script` | `script_path`, `symptom?` | Diagnose and fix a misbehaving script |
| `roblox_review_script` | `script_path`, `focus?` | Review a script for bugs and performance |
| `blender_build_scene` | `description` | Plan and build a Blender scene with `bpy` |

### Resources

Readable context data exposed over MCP - attach them to a conversation for live state.

| Resource URI | Description |
|--------------|-------------|
| `mcpbridge://guide` | Agent skill guide (`skills.md`) - tools, workflows, rules |
| `mcpbridge://server/info` | Server version, ports, default model, capability counts |
| `mcpbridge://studio/status` | Live Roblox Studio connection state |
| `mcpbridge://studio/output` | Recent Roblox Studio output log |
| `mcpbridge://blender/status` | Live Blender connection state |
| `mcpbridge://blender/output` | Recent Blender output log |

---

## 💬 Example Prompts

**Roblox Studio:**
```
"List all scripts in my Roblox game"

"Read the source of game.ServerScriptService.GameManager"

"Generate a Roblox Lua leaderboard system and write it to game.ServerScriptService.Leaderboard"

"Review game.StarterPlayer.StarterCharacterScripts.Movement for performance issues"

"Create a new LocalScript called 'UIHandler' in game.StarterPlayer.StarterPlayerScripts"
```

**Blender:**
```
"What objects are in my Blender scene?"

"Add a subdivided cube at the origin with 3 levels of subdivision"

"Generate a Python script to create a low-poly tree and execute it in Blender"

"Select all mesh objects in the scene and apply a smooth shading modifier"

"What is the current render engine and frame range?"
```

---

## 🔧 Troubleshooting

<details>
<summary><b>Roblox plugin shows 🔴 Disconnected</b></summary>

- Make sure the MCP server is running (Claude Code must have it active)
- Confirm HTTP requests are enabled in Studio Settings
- Check that port `7842` isn't blocked by a firewall

</details>

<details>
<summary><b>Blender plugin shows 🔴 Disconnected</b></summary>

- Make sure the MCP server is running (Claude Code must have it active)
- Check that port `7843` isn't blocked by a firewall
- Confirm the MCPBridge addon is enabled in **Edit → Preferences → Add-ons**
- Try clicking **Stop Bridge** then **Start Bridge** again in the sidebar

</details>

<details>
<summary><b>Both plugins disconnected / MCP server won't start</b></summary>

This is almost always caused by having duplicate entries in `claude.json` (e.g. old `roblox-ollama` and `blender-mcp` entries both pointing at `index.js`). Two Node processes fighting over port `7842` causes both to fail.

**Fix:** Open MCPBridge, click **Apply Changes**. This replaces any old entries with a single `mcpbridge` entry. Then restart Claude Code.

</details>

<details>
<summary><b>Ollama errors</b></summary>

- Confirm Ollama is running: `curl http://localhost:11434/api/tags`
- Make sure `minimax-m2.5:cloud` is available in your Ollama setup

</details>

<details>
<summary><b>"Command timed out"</b></summary>

- The plugin may have been deactivated - click the toolbar/sidebar button again
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
MCPBridge/
├── mcp-server/
│   ├── index.js               ← Unified MCP + HTTP bridge server (Roblox :7842, Blender :7843)
│   └── package.json
├── roblox-plugin/
│   └── OllamaMCP.lua          ← Roblox Studio plugin (auto-installed by MCPBridge app)
├── blender-plugin/
│   └── MCPBridge.py           ← Blender addon (install manually via Edit → Preferences)
├── MCPBridge.exe              ← Windows installer (double-click to run)
├── MCPBridge.pkg              ← macOS installer (double-click to run)
├── claude_mcp_config.json     ← Example Claude Code config snippet
├── server.json                ← Official MCP Registry manifest
├── skills.md                  ← Agent skill guide (also served as the mcpbridge://guide resource)
├── start.sh                   ← Helper startup script
├── LICENSE                    ← MIT license
└── README.md
```

---

## 📄 License

MCPBridge is released under the [MIT License](LICENSE).
