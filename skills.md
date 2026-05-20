# MCPBridge - Agent Skill Guide

> How Claude Code (and any other MCP-aware agent) should drive **MCPBridge** to
> control **Roblox Studio** and **Blender**. Read this before calling any
> `studio_*`, `blender_*`, or `ollama_*` tool.

---

## 1. What MCPBridge is

MCPBridge is a single MCP server (`mcp-server/index.js`) that exposes **17 tools**
over stdio and bridges them to two live applications over local HTTP:

```
Agent (MCP/stdio)
   │
   ▼
MCPBridge server ──HTTP 127.0.0.1:7842──► Roblox Studio plugin (Lua)
   │
   ├──────────────HTTP 127.0.0.1:7843──► Blender plugin (Python / bpy)
   │
   └──────────────HTTP localhost:11434─► Ollama  (default model: minimax-m2.5:cloud)
```

The server registers in `claude.json` under the **single** key `mcpbridge`. In
Claude Code the tools are namespaced as `mcp__mcpbridge__<tool_name>` (e.g.
`mcp__mcpbridge__studio_status`). This guide uses the bare tool names.

### How the bridge actually works (important)

- The plugins are **pollers**, not servers. The Roblox/Blender plugin polls the
  MCPBridge server every few seconds for queued commands, runs them, and POSTs
  results back.
- Every command tool **blocks until the plugin returns a result**, with a
  **30-second timeout**. A timeout almost always means the plugin is not active.
- The server keeps a plugin "connected" only if it has polled within the **last
  8 seconds**. Stale connections silently report as disconnected.

---

## 2. Golden rules for agents

1. **Always check connection first.** Call `studio_status` before any `studio_*`
   tool, and `blender_status` before any `blender_*` tool. If disconnected, stop
   and tell the user how to activate the plugin - do not retry blindly.
2. **A "Command timed out" error is a connection problem, not a code problem.**
   Re-check status; ask the user to click the toolbar/sidebar button again.
3. **Read before you write.** Call `studio_read_script` before `studio_write_script`
   - `studio_write_script` **overwrites the entire file**, there is no patch/append.
4. **Prefer the deterministic tools over the `ollama_*` generators.** The
   `ollama_*` tools delegate to a separate LLM and return non-deterministic code.
   If *you* are the agent, you should usually write the Lua/Python yourself and
   push it with `studio_write_script` / `blender_execute_python`. Reach for
   `ollama_generate_lua` / `ollama_generate_python` only when the user explicitly
   asks for Ollama generation or when offloading is desired.
5. **Use full dot-separated instance paths** for Roblox, e.g.
   `game.ServerScriptService.GameManager`. There is no fuzzy lookup.
6. **`studio_execute_lua` runs in the plugin context**, not in a running game -
   no `Players`, no live players. It is for editor-time automation.
7. **`blender_execute_python` runs real `bpy`** against the open scene. Treat it
   as destructive: inspect the scene with `blender_get_scene_info` first, and
   confirm with the user before bulk deletes or irreversible operations.
8. **Output tools are passive caches.** `studio_get_output` / `blender_get_output`
   return whatever the plugin has pushed (last 200 lines); they do not trigger a
   refresh. Empty output usually means the plugin just started.

---

## 3. Tool reference

All tools live under the `mcpbridge` server. `req` = required, `opt` = optional.

### 3.1 Roblox Studio - connection & inspection

| Tool | Params | Returns |
|------|--------|---------|
| `studio_status` | none | Connected/disconnected + last-seen age + queue length |
| `studio_list_scripts` | none | Every `Script` / `LocalScript` / `ModuleScript`: `[type] path` |
| `studio_get_workspace_info` | none | Place metadata JSON (place name, game ID, etc.) |
| `studio_get_selection` | none | Instances currently selected in the Explorer |

### 3.2 Roblox Studio - scripts

| Tool | Params | Notes |
|------|--------|-------|
| `studio_read_script` | `path` (req) | Full path e.g. `game.ServerScriptService.MyScript` |
| `studio_write_script` | `path` (req), `source` (req) | **Overwrites** the whole script source |
| `studio_create_script` | `parent_path` (req), `name` (req), `script_type` (opt: `Script`\|`LocalScript`\|`ModuleScript`, default `Script`), `source` (opt) | Creates a new script instance under the parent |

### 3.3 Roblox Studio - execution & logs

| Tool | Params | Notes |
|------|--------|-------|
| `studio_execute_lua` | `code` (req) | Runs Lua in the **plugin** context; returns the value or "no return value" |
| `studio_get_output` | `lines` (opt, default 50, max 200) | Recent print/warn/error lines cached by the plugin |

### 3.4 Blender

| Tool | Params | Notes |
|------|--------|-------|
| `blender_status` | none | Connected/disconnected + last-seen age + queue length |
| `blender_get_scene_info` | none | Scene objects, active object, render settings as JSON |
| `blender_execute_python` | `code` (req) | Runs `bpy` Python in the live Blender session |
| `blender_get_output` | `lines` (opt, default 50, max 200) | Recent log lines cached by the plugin |

### 3.5 Ollama (LLM-backed generators)

| Tool | Params | Notes |
|------|--------|-------|
| `ollama_generate` | `prompt` (req), `model` (opt) | Raw prompt → completion |
| `ollama_generate_lua` | `task` (req), `existing_code` (opt), `apply_to` (opt), `model` (opt) | Generates Luau; if `apply_to` is a script path, writes it straight to Studio |
| `ollama_review_script` | `path` (req), `focus` (opt: e.g. `performance`, `security`, `readability`) | Reads the script from Studio, returns a structured review |
| `ollama_generate_python` | `task` (req), `existing_code` (opt), `execute_in_blender` (opt bool, default false), `model` (opt) | Generates `bpy` code; if `execute_in_blender` is true, runs it in Blender |

Default model: `minimax-m2.5:cloud`. Override per call with `model`. The Ollama
REST API must be reachable at `http://localhost:11434`.

---

## 4. Standard workflows

### Edit an existing Roblox script
```
1. studio_status                     → confirm 🟢
2. studio_list_scripts                → locate the exact path
3. studio_read_script   { path }      → get current source
4. (you edit the source)
5. studio_write_script  { path, source }
6. studio_get_output                  → check for compile/runtime warnings
```

### Create a new Roblox script
```
1. studio_status
2. studio_create_script { parent_path, name, script_type, source }
3. studio_read_script   { path }      → verify it landed
```

### Inspect & modify a Blender scene
```
1. blender_status
2. blender_get_scene_info             → know what exists before changing it
3. blender_execute_python { code }    → make the change
4. blender_get_output                 → check for tracebacks
```

### Offload generation to Ollama
- Roblox: `ollama_generate_lua { task, apply_to }` - writes directly to Studio.
- Blender: `ollama_generate_python { task, execute_in_blender: true }` - runs in Blender.
- Omit `apply_to` / `execute_in_blender` to review the code before applying it.

### Review a Roblox script
```
ollama_review_script { path, focus: "performance" }
```

---

## 5. Roblox Lua conventions (for code you write or push)

The bundled Ollama prompt enforces these - match them so generated and
hand-written code stay consistent:

- Use **modern Luau APIs**: `game:GetService(...)`, `task.wait()`, `task.spawn()`.
- **Never** use deprecated `wait()`, `spawn()`, `delay()`.
- `Script` runs server-side, `LocalScript` client-side, `ModuleScript` is a
  required library. Pick `script_type` accordingly.
- Add brief inline comments only for non-obvious logic.

## 6. Blender Python conventions

- Use `bpy.ops`, `bpy.context`, `bpy.data` correctly; guard against missing
  context (operators need the right area/mode).
- Handle errors gracefully - an uncaught exception surfaces as a tool error.
- Prefer data-API edits (`bpy.data`) over operator calls when feasible; they are
  less context-sensitive.

---

## 7. Troubleshooting (agent-facing)

| Symptom | Cause | What to tell the user |
|---------|-------|-----------------------|
| `studio_status` → ❌ | Plugin not active | Install `OllamaMCP.lua`, click the **"MCP Bridge"** toolbar button, enable *Studio as MCP server* under Assistant → Manage MCP Servers |
| `blender_status` → ❌ | Plugin not active | Enable the **MCPBridge** add-on, open 3D Viewport sidebar (`N`) → **MCPBridge** tab → **Start Bridge** |
| "Command timed out" | Plugin stopped polling | Re-activate the toolbar/sidebar button; the 30s deadline expired |
| Both plugins dead / server won't start | Duplicate entries in `claude.json` fighting over port `7842` | Run MCPBridge app → **Apply Changes** to collapse to one `mcpbridge` entry, then restart Claude Code |
| `Ollama error <status>` | Ollama not running or model missing | `curl http://localhost:11434/api/tags`; ensure `minimax-m2.5:cloud` is pulled |
| Empty `*_get_output` | Plugin just started, nothing cached | Normal - run an action first, output is cached after the plugin pushes it |

---

## 8. Quick capability summary

- **Can do:** list/read/write/create Roblox scripts, run editor-time Lua, inspect
  workspace & selection, read Studio output, run live `bpy` in Blender, inspect
  Blender scenes, generate & review code via Ollama.
- **Cannot do:** run code inside a *playing* Roblox game, partial/patch script
  edits (writes are full overwrites), control apps that have not activated their
  plugin, reach anything outside `127.0.0.1:7842` / `:7843` / `localhost:11434`.
