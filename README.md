<div align="center">

# MCPBridge

**Connect Claude Code and Ollama to Roblox Studio and Blender via the Model Context Protocol**

[![Platform - Windows](https://img.shields.io/badge/platform-Windows-0078d4?logo=windows&logoColor=white)](https://github.com)
[![Platform - macOS](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)](https://github.com)
[![Node.js - 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
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

### 3 - No `npm install` needed

Since v1.1 the MCP server has no dependencies: it runs with Node.js alone. If you look in
`mcp-server/` and find nothing to install, that is correct. Skip straight to the next step.

To check that Node.js works, run this from the extracted folder. It should print
`MCPBridge 1.1.0 ready` and then wait (press Ctrl+C to stop it):

```bash
node mcp-server/index.js
```

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

**Option A - from npm (recommended).** `npx` fetches and runs the server:

```json
{
  "mcpServers": {
    "mcpbridge": {
      "command": "npx",
      "args": ["-y", "@iamjrmh/mcpbridge@latest"]
    }
  }
}
```

**Option B - from local source.** Use this if you downloaded the repo (replace the path with your actual path; no `npm install` needed):

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

`studio_execute_lua` and `blender_execute_python` can do anything the application's own
scripting API allows. The other tools are shortcuts for the common jobs.

### Studio Tools (Roblox)

| Tool | Description |
|------|-------------|
| `studio_status` | Is the Studio plugin connected, and what to do if not |
| `studio_execute_lua` | Run any Luau in Studio; returns values, printed output and errors |
| `studio_get_tree` | Instance tree under a path |
| `studio_find_instances` | Search by name and/or class |
| `studio_get_properties` | Read an instance's properties, attributes and tags |
| `studio_set_properties` | Change properties, attributes and tags on one or many instances |
| `studio_create_instance` | Create any class, with properties and nested children |
| `studio_delete_instance` | Delete instances (undoable) |
| `studio_clone_instance` | Copy an instance, optionally to a new parent |
| `studio_move_instance` | Reparent and/or rename an instance |
| `studio_insert_asset` | Insert a marketplace asset by id |
| `studio_list_scripts` | List scripts with class and line count |
| `studio_read_script` | Read a script's source |
| `studio_write_script` | Replace a script's source (creates it if missing) |
| `studio_edit_script` | Replace one piece of text inside a script |
| `studio_create_script` | Create a Script, LocalScript or ModuleScript |
| `studio_get_output` | Recent Output window lines (prints, warnings, errors) |
| `studio_get_workspace_info` | Place name and ids, counts, playtest state |
| `studio_get_selection` | What is selected in the Explorer |
| `studio_set_selection` | Select instances, to show the user what changed |
| `studio_undo` / `studio_redo` | Step Studio's undo history |

Property values are plain JSON: Vector3 `[x,y,z]`, Color3 `"#RRGGBB"`, CFrame
`{"position":[x,y,z],"rotation":[rx,ry,rz]}`, UDim2 `[xs,xo,ys,yo]`, enums by name, instances by path.

### Blender Tools

| Tool | Description |
|------|-------------|
| `blender_status` | Is the Blender add-on connected, and what to do if not |
| `blender_execute_python` | Run any Python (bpy) in Blender; returns the last expression, printed output and errors |
| `blender_get_scene_info` | Scene objects, active object, render settings |
| `blender_get_object` | One object's transform, mesh counts, materials, modifiers |
| `blender_get_output` | Recent lines printed through MCPBridge |
| `blender_list_texts` / `blender_read_text` / `blender_write_text` | Text blocks in the .blend file |

### Ollama Tools

| Tool | Description |
|------|-------------|
| `ollama_list_models` | Models available in the local Ollama |
| `ollama_generate` | Any prompt (with optional system prompt and options) to a model |
| `ollama_generate_lua` | Generate Roblox Luau for a task, optionally write it to Studio |
| `ollama_review_script` | Review a Studio script for bugs and performance |
| `ollama_generate_python` | Generate Blender Python for a task, optionally run it |

Every tool that runs something takes `timeout_seconds` (default 60, up to 600) for long jobs.

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
<summary><b>Plugin says Connected, but every tool gives an error</b></summary>

This was a bug in v1.0 ([issue #1](https://github.com/iamjrmh/MCPBridge/issues/1)). The MCP server kept
running after its Claude Code session closed and held on to ports `7842` / `7843`. The plugin kept talking
to that leftover server (so it showed Connected) while the server of your new session could not open the
ports, so its tools all failed.

**Fix:**
1. Update to v1.1: replace `mcp-server/index.js` and `roblox-plugin/OllamaMCP.lua` (and the Blender add-on)
   with the new files. If you use npx, set the args to `["-y", "@iamjrmh/mcpbridge@latest"]` so it always runs the newest server.
2. Close Claude Code, then end any leftover `node` (Windows: `node.exe`) processes in Task Manager / Activity Monitor once.
3. Start Claude Code again and ask it to run `studio_status`.

From v1.1 on, the server exits with its session, several sessions can be open at once (they share the
connection), and a tool that cannot reach the plugin says why within a few seconds.

</details>

<details>
<summary><b>"There is nothing to install" in mcp-server</b></summary>

Correct: since v1.1 the server has no dependencies, so there is no `npm install` step. You only need Node.js 18 or newer.

</details>

<details>
<summary><b>Roblox plugin keeps waiting for the MCP server</b></summary>

- The MCP server only runs while your AI coding session (Claude Code) is open with `mcpbridge` in its config
- Ask the agent to run `studio_status`; its answer says what is wrong
- If Studio asked whether the plugin may make HTTP requests to `127.0.0.1`, allow it (Plugins > Manage Plugins)
- Check that port `7842` isn't blocked by a firewall

</details>

<details>
<summary><b>Blender plugin shows 🔴 Disconnected</b></summary>

- The MCP server only runs while your AI coding session is open with `mcpbridge` in its config
- Check that port `7843` isn't blocked by a firewall
- Confirm the MCPBridge addon is enabled in **Edit → Preferences → Add-ons**
- Try clicking **Stop Bridge** then **Start Bridge** again in the sidebar

</details>

<details>
<summary><b>A tool says a port is "in use by another program"</b></summary>

Something that is not MCPBridge is using port `7842` or `7843`. Close that program, or (for old setups) remove
leftover `roblox-ollama` / `blender-mcp` entries from `claude.json`; the MCPBridge app's **Apply Changes** does that for you.

</details>

<details>
<summary><b>Ollama errors</b></summary>

- Confirm Ollama is running: `curl http://localhost:11434/api/tags`
- Make sure `minimax-m2.5:cloud` is available in your Ollama setup

</details>

<details>
<summary><b>"Command timed out"</b></summary>

- Long jobs: pass a larger `timeout_seconds` to the tool (up to 600)
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
│   ├── index.js               ← Unified MCP + HTTP bridge server (Roblox :7842, Blender :7843), no dependencies
│   ├── test/                  ← `node --test mcp-server/test/bridge.test.mjs`
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
