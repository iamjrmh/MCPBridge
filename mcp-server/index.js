#!/usr/bin/env node
/**
 * MCPBridge — Unified Roblox + Blender MCP Server
 * ─────────────────────────────────────────────────
 * Speaks MCP (stdio) to Claude Code while running an HTTP server
 * with two independent poll/result/state channels:
 *
 *   Port 7842  →  Roblox Studio plugin
 *   Port 7843  →  Blender plugin
 *
 * Register ONE entry in claude.json:
 *   "mcpbridge": { "command": "node", "args": ["<path>/index.js"] }
 *
 * Ollama model: minimax-m2.5:cloud
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ─────────────────────────────────────────────
// HTTP bridge server (for Roblox Studio plugin)
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const ROBLOX_PORT = 7842;
const BLENDER_PORT = 7843;
const OLLAMA_BASE = "http://localhost:11434";
const DEFAULT_MODEL = "minimax-m2.5:cloud";

// ── Roblox state ──
const commandQueue = [];
const resultStore = new Map();
const studioState = {
  connected: false,
  lastSeen: null,
  scripts: [],
  output: [],
  metadata: {},
};

// ── Blender state ──
const blenderCommandQueue = [];
const blenderResultStore = new Map();
const blenderState = {
  connected: false,
  lastSeen: null,
  objects: [],
  output: [],
  metadata: {},
};

// ─────────────────────────────────────────────
// Roblox HTTP bridge (port 7842)
// ─────────────────────────────────────────────

// ── Roblox plugin polling endpoint ──
app.get("/poll", (req, res) => {
  studioState.connected = true;
  studioState.lastSeen = Date.now();

  if (commandQueue.length > 0) {
    const cmd = commandQueue.shift();
    res.json({ hasCommand: true, command: cmd });
  } else {
    res.json({ hasCommand: false });
  }
});

// ── Roblox plugin posts results here ──
app.post("/result", (req, res) => {
  const { commandId, result, error } = req.body;
  if (commandId) {
    resultStore.set(commandId, { result, error, timestamp: Date.now() });
  }
  res.json({ ok: true });
});

// ── Roblox plugin pushes state updates here ──
app.post("/state", (req, res) => {
  const { scripts, output, metadata } = req.body;
  if (Array.isArray(scripts)) studioState.scripts = scripts;
  if (Array.isArray(output)) {
    studioState.output = [...studioState.output, ...output].slice(-200);
  }
  if (metadata) studioState.metadata = { ...studioState.metadata, ...metadata };
  res.json({ ok: true });
});

// ── Roblox health check ──
app.get("/health", (_req, res) => {
  const connected =
    studioState.connected &&
    studioState.lastSeen &&
    Date.now() - studioState.lastSeen < 8000;
  res.json({
    bridge: "ok",
    studioConnected: connected,
    lastSeen: studioState.lastSeen,
    queueLength: commandQueue.length,
  });
});

const robloxBridge = app.listen(ROBLOX_PORT, "127.0.0.1", () => {
  process.stderr.write(
    `[MCPBridge] Roblox HTTP bridge listening on http://127.0.0.1:${ROBLOX_PORT}\n`
  );
});
// A port conflict must not take down the MCP server — log and keep going.
robloxBridge.on("error", (e) => {
  process.stderr.write(
    `[MCPBridge] Roblox HTTP bridge could not bind :${ROBLOX_PORT} — ${e.message}\n`
  );
});

// ─────────────────────────────────────────────
// Blender HTTP bridge (port 7843)
// ─────────────────────────────────────────────
const blenderApp = express();
blenderApp.use(cors());
blenderApp.use(express.json({ limit: "10mb" }));

// ── Blender plugin polling endpoint ──
blenderApp.get("/poll", (req, res) => {
  blenderState.connected = true;
  blenderState.lastSeen = Date.now();

  if (blenderCommandQueue.length > 0) {
    const cmd = blenderCommandQueue.shift();
    res.json({ hasCommand: true, command: cmd });
  } else {
    res.json({ hasCommand: false });
  }
});

// ── Blender plugin posts results here ──
blenderApp.post("/result", (req, res) => {
  const { commandId, result, error } = req.body;
  if (commandId) {
    blenderResultStore.set(commandId, { result, error, timestamp: Date.now() });
  }
  res.json({ ok: true });
});

// ── Blender plugin pushes state updates here ──
blenderApp.post("/state", (req, res) => {
  const { objects, output, metadata } = req.body;
  if (Array.isArray(objects)) blenderState.objects = objects;
  if (Array.isArray(output)) {
    blenderState.output = [...blenderState.output, ...output].slice(-200);
  }
  if (metadata) blenderState.metadata = { ...blenderState.metadata, ...metadata };
  res.json({ ok: true });
});

// ── Blender health check ──
blenderApp.get("/health", (_req, res) => {
  const connected =
    blenderState.connected &&
    blenderState.lastSeen &&
    Date.now() - blenderState.lastSeen < 8000;
  res.json({
    bridge: "ok",
    blenderConnected: connected,
    lastSeen: blenderState.lastSeen,
    queueLength: blenderCommandQueue.length,
  });
});

const blenderBridge = blenderApp.listen(BLENDER_PORT, "127.0.0.1", () => {
  process.stderr.write(
    `[MCPBridge] Blender HTTP bridge listening on http://127.0.0.1:${BLENDER_PORT}\n`
  );
});
// A port conflict must not take down the MCP server — log and keep going.
blenderBridge.on("error", (e) => {
  process.stderr.write(
    `[MCPBridge] Blender HTTP bridge could not bind :${BLENDER_PORT} — ${e.message}\n`
  );
});

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

/** Send a command to Roblox and wait for the result. */
async function sendToStudio(type, payload = {}, timeoutMs = 30_000) {
  const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  commandQueue.push({ id: commandId, type, payload });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (resultStore.has(commandId)) {
      const r = resultStore.get(commandId);
      resultStore.delete(commandId);
      if (r.error) throw new Error(r.error);
      return r.result;
    }
    await sleep(150);
  }
  const idx = commandQueue.findIndex((c) => c.id === commandId);
  if (idx !== -1) commandQueue.splice(idx, 1);
  throw new Error(
    "Command timed out — is the Roblox Studio plugin connected and active?"
  );
}

/** Send a command to Blender and wait for the result. */
async function sendToBlender(type, payload = {}, timeoutMs = 30_000) {
  const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  blenderCommandQueue.push({ id: commandId, type, payload });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (blenderResultStore.has(commandId)) {
      const r = blenderResultStore.get(commandId);
      blenderResultStore.delete(commandId);
      if (r.error) throw new Error(r.error);
      return r.result;
    }
    await sleep(150);
  }
  const idx = blenderCommandQueue.findIndex((c) => c.id === commandId);
  if (idx !== -1) blenderCommandQueue.splice(idx, 1);
  throw new Error(
    "Command timed out — is the Blender MCPBridge plugin connected and active?"
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isStudioConnected() {
  return (
    studioState.connected &&
    studioState.lastSeen &&
    Date.now() - studioState.lastSeen < 8000
  );
}

function isBlenderConnected() {
  return (
    blenderState.connected &&
    blenderState.lastSeen &&
    Date.now() - blenderState.lastSeen < 8000
  );
}

/** Call the Ollama generate endpoint. */
async function ollamaGenerate(prompt, model = DEFAULT_MODEL) {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.response ?? "";
}

/** Call the Ollama chat endpoint (keeps conversation context). */
async function ollamaChat(messages, model = DEFAULT_MODEL) {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.message?.content ?? "";
}

/** Strip markdown code fences from a string. */
function stripCodeFences(text) {
  const m = text.match(/```(?:lua)?\n?([\s\S]*?)\n?```/);
  return m ? m[1].trim() : text.trim();
}

// ─────────────────────────────────────────────
// MCP Server definition
// ─────────────────────────────────────────────
const server = new Server(
  { name: "mcpbridge", version: "1.0.0" },
  { capabilities: { tools: {}, prompts: {}, resources: {} } }
);

// ── Tool list ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Studio connection ──
    {
      name: "studio_status",
      description:
        "Check whether the Roblox Studio plugin is currently connected to the MCP bridge.",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Script management ──
    {
      name: "studio_list_scripts",
      description:
        "List all Script, LocalScript, and ModuleScript instances in the current Roblox place.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "studio_read_script",
      description: "Read the source code of a script by its full instance path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Full dot-separated path, e.g. "game.ServerScriptService.MyScript"',
          },
        },
        required: ["path"],
      },
    },
    {
      name: "studio_write_script",
      description: "Overwrite the source code of a script in Roblox Studio.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Full path, e.g. "game.ServerScriptService.MyScript"',
          },
          source: { type: "string", description: "New Lua source code" },
        },
        required: ["path", "source"],
      },
    },
    {
      name: "studio_create_script",
      description:
        "Create a new Script, LocalScript, or ModuleScript inside a parent instance.",
      inputSchema: {
        type: "object",
        properties: {
          parent_path: {
            type: "string",
            description:
              'Path to the parent instance, e.g. "game.ServerScriptService"',
          },
          name: { type: "string", description: "Name for the new script" },
          script_type: {
            type: "string",
            enum: ["Script", "LocalScript", "ModuleScript"],
            description: "Type of script to create (default: Script)",
          },
          source: {
            type: "string",
            description: "Initial source code (optional)",
          },
        },
        required: ["parent_path", "name"],
      },
    },

    // ── Execution ──
    {
      name: "studio_execute_lua",
      description:
        "Execute arbitrary Lua code in the Roblox Studio plugin context (runs in the plugin, not in-game).",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Lua code to execute" },
        },
        required: ["code"],
      },
    },

    // ── Output ──
    {
      name: "studio_get_output",
      description:
        "Get recent print/warn/error output lines captured by the Studio plugin.",
      inputSchema: {
        type: "object",
        properties: {
          lines: {
            type: "number",
            description: "How many recent lines to return (default 50, max 200)",
          },
        },
      },
    },

    // ── Workspace info ──
    {
      name: "studio_get_workspace_info",
      description:
        "Get metadata about the currently open Roblox place (place name, game ID, etc.).",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Selection ──
    {
      name: "studio_get_selection",
      description:
        "Get the currently selected instance(s) in Roblox Studio's Explorer panel.",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Ollama direct ──
    {
      name: "ollama_generate",
      description: `Send a raw prompt to Ollama (model: ${DEFAULT_MODEL}) and get a completion.`,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt text" },
          model: {
            type: "string",
            description: `Ollama model override (default: ${DEFAULT_MODEL})`,
          },
        },
        required: ["prompt"],
      },
    },

    // ── Ollama Lua generation ──
    {
      name: "ollama_generate_lua",
      description:
        "Ask Ollama to write or refactor Roblox Lua code, then optionally write it directly to a Studio script.",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Natural language description of what the code should do",
          },
          existing_code: {
            type: "string",
            description: "Existing script source to refactor or extend (optional)",
          },
          apply_to: {
            type: "string",
            description:
              "If set, write the generated code to this script path in Studio (optional)",
          },
          model: {
            type: "string",
            description: `Model override (default: ${DEFAULT_MODEL})`,
          },
        },
        required: ["task"],
      },
    },

    // ── Ollama code review ──
    {
      name: "ollama_review_script",
      description:
        "Have Ollama review a Roblox Studio script for bugs, performance issues, or style problems.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the script to review in Studio",
          },
          focus: {
            type: "string",
            description:
              'Optional focus area, e.g. "performance", "security", "readability"',
          },
        },
        required: ["path"],
      },
    },

    // ── Blender connection ──
    {
      name: "blender_status",
      description: "Check whether the Blender MCPBridge plugin is connected.",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Blender execution ──
    {
      name: "blender_execute_python",
      description: "Execute arbitrary Python code inside Blender via the MCPBridge plugin.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python code to execute in Blender" },
        },
        required: ["code"],
      },
    },

    // ── Blender scene info ──
    {
      name: "blender_get_scene_info",
      description: "Get information about the current Blender scene: objects, active object, render settings, etc.",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Blender output ──
    {
      name: "blender_get_output",
      description: "Get recent output/log lines captured by the Blender plugin.",
      inputSchema: {
        type: "object",
        properties: {
          lines: {
            type: "number",
            description: "How many recent lines to return (default 50, max 200)",
          },
        },
      },
    },

    // ── Ollama Python generation ──
    {
      name: "ollama_generate_python",
      description: "Ask Ollama to write Blender Python (bpy) code, then optionally execute it in Blender.",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Natural language description of what the Blender Python code should do",
          },
          existing_code: {
            type: "string",
            description: "Existing Python code to refactor or extend (optional)",
          },
          execute_in_blender: {
            type: "boolean",
            description: "If true, send the generated code to Blender for execution (default: false)",
          },
          model: {
            type: "string",
            description: `Model override (default: ${DEFAULT_MODEL})`,
          },
        },
        required: ["task"],
      },
    },
  ],
}));

// ── Tool handlers ──
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const text = (t) => ({ content: [{ type: "text", text: String(t) }] });
  const err = (e) => ({
    content: [{ type: "text", text: `❌ Error: ${e}` }],
    isError: true,
  });

  try {
    switch (name) {
      // ──────────────── Studio connection ────────────────
      case "studio_status": {
        const connected = isStudioConnected();
        const age = studioState.lastSeen
          ? `${Math.round((Date.now() - studioState.lastSeen) / 1000)}s ago`
          : "never";
        return text(
          connected
            ? `✅ Roblox Studio plugin is CONNECTED (last seen ${age})\nQueue: ${commandQueue.length} pending commands`
            : `❌ Roblox Studio plugin is NOT connected (last seen ${age})\n\nMake sure you have:\n1. Installed the plugin in Roblox Studio\n2. Clicked the "OllamaMCP" toolbar button to activate it`
        );
      }

      // ──────────────── Script management ────────────────
      case "studio_list_scripts": {
        const scripts = await sendToStudio("list_scripts", {});
        if (!Array.isArray(scripts) || scripts.length === 0) {
          return text("No scripts found in the current place.");
        }
        const lines = scripts.map(
          (s) => `  [${s.type}] ${s.path}`
        );
        return text(`Found ${scripts.length} scripts:\n${lines.join("\n")}`);
      }

      case "studio_read_script": {
        const source = await sendToStudio("read_script", { path: args.path });
        return text(`-- Source: ${args.path}\n\`\`\`lua\n${source}\n\`\`\``);
      }

      case "studio_write_script": {
        await sendToStudio("write_script", {
          path: args.path,
          source: args.source,
        });
        return text(`✅ Updated source of ${args.path}`);
      }

      case "studio_create_script": {
        const result = await sendToStudio("create_script", {
          parent_path: args.parent_path,
          name: args.name,
          script_type: args.script_type ?? "Script",
          source: args.source ?? "",
        });
        return text(`✅ Created ${args.script_type ?? "Script"} "${args.name}" in ${args.parent_path}\nPath: ${result}`);
      }

      // ──────────────── Execution ────────────────
      case "studio_execute_lua": {
        const result = await sendToStudio("execute", { code: args.code });
        return text(
          result !== undefined && result !== null
            ? `Result: ${JSON.stringify(result, null, 2)}`
            : "✅ Executed (no return value)"
        );
      }

      // ──────────────── Output ────────────────
      case "studio_get_output": {
        const n = Math.min(args.lines ?? 50, 200);
        const lines = studioState.output.slice(-n);
        return text(
          lines.length > 0
            ? `Last ${lines.length} output lines:\n\n${lines.join("\n")}`
            : "(No output captured yet — make sure the plugin is active)"
        );
      }

      // ──────────────── Workspace info ────────────────
      case "studio_get_workspace_info": {
        const info = await sendToStudio("workspace_info", {});
        return text(JSON.stringify(info, null, 2));
      }

      // ──────────────── Selection ────────────────
      case "studio_get_selection": {
        const sel = await sendToStudio("get_selection", {});
        if (!Array.isArray(sel) || sel.length === 0) {
          return text("Nothing is selected in the Explorer.");
        }
        return text(
          `Selected ${sel.length} instance(s):\n${sel.map((s) => `  ${s.path} [${s.className}]`).join("\n")}`
        );
      }

      // ──────────────── Ollama direct ────────────────
      case "ollama_generate": {
        const response = await ollamaGenerate(
          args.prompt,
          args.model ?? DEFAULT_MODEL
        );
        return text(response);
      }

      // ──────────────── Ollama Lua generation ────────────────
      case "ollama_generate_lua": {
        const contextBlock = args.existing_code
          ? `\n\nExisting code to refactor/extend:\n\`\`\`lua\n${args.existing_code}\n\`\`\``
          : "";

        const prompt = `You are an expert Roblox Studio Lua developer (Luau). Write clean, idiomatic, production-ready Roblox Lua code for the following task.

Task: ${args.task}${contextBlock}

Rules:
- Use modern Roblox APIs (game:GetService, task.wait, etc.)
- Do NOT use deprecated APIs (wait(), spawn(), delay())
- Include brief inline comments for non-obvious logic
- Respond with ONLY the Lua code inside a single \`\`\`lua ... \`\`\` block`;

        const raw = await ollamaGenerate(prompt, args.model ?? DEFAULT_MODEL);
        const code = stripCodeFences(raw);

        let applyNote = "";
        if (args.apply_to) {
          await sendToStudio("write_script", {
            path: args.apply_to,
            source: code,
          });
          applyNote = `\n\n✅ Written to ${args.apply_to}`;
        }

        return text(`Generated Lua code:\n\`\`\`lua\n${code}\n\`\`\`${applyNote}`);
      }

      // ──────────────── Ollama code review ────────────────
      case "ollama_review_script": {
        const source = await sendToStudio("read_script", { path: args.path });

        const focusLine = args.focus
          ? `Focus specifically on: ${args.focus}.`
          : "Cover bugs, performance, deprecated APIs, and style.";

        const prompt = `You are a senior Roblox Studio Lua engineer. Review the following script and provide actionable feedback. ${focusLine}

Script path: ${args.path}
\`\`\`lua
${source}
\`\`\`

Provide your review in these sections:
1. Summary (1–2 sentences)
2. Issues Found (list each with severity: 🔴 Critical / 🟡 Warning / 🔵 Info)
3. Suggested Improvements (code snippets where helpful)`;

        const review = await ollamaGenerate(
          prompt,
          DEFAULT_MODEL
        );
        return text(`# Code Review: ${args.path}\n\n${review}`);
      }

      // ──────────────── Blender connection ────────────────
      case "blender_status": {
        const connected = isBlenderConnected();
        const age = blenderState.lastSeen
          ? `${Math.round((Date.now() - blenderState.lastSeen) / 1000)}s ago`
          : "never";
        return text(
          connected
            ? `✅ Blender plugin is CONNECTED (last seen ${age})\nQueue: ${blenderCommandQueue.length} pending commands`
            : `❌ Blender plugin is NOT connected (last seen ${age})\n\nMake sure you have:\n1. Installed the MCPBridge addon in Blender\n2. Enabled it in Edit → Preferences → Add-ons\n3. Clicked \"Start Bridge\" in the 3D Viewport sidebar → MCPBridge tab`
        );
      }

      // ──────────────── Blender execution ────────────────
      case "blender_execute_python": {
        const result = await sendToBlender("execute", { code: args.code });
        return text(
          result !== undefined && result !== null
            ? `Result: ${JSON.stringify(result, null, 2)}`
            : "✅ Executed (no return value)"
        );
      }

      // ──────────────── Blender scene info ────────────────
      case "blender_get_scene_info": {
        const info = await sendToBlender("scene_info", {});
        return text(JSON.stringify(info, null, 2));
      }

      // ──────────────── Blender output ────────────────
      case "blender_get_output": {
        const n = Math.min(args.lines ?? 50, 200);
        const lines = blenderState.output.slice(-n);
        return text(
          lines.length > 0
            ? `Last ${lines.length} output lines:\n\n${lines.join("\n")}`
            : "(No output captured yet — make sure the plugin is active)"
        );
      }

      // ──────────────── Ollama Python generation ────────────────
      case "ollama_generate_python": {
        const contextBlock = args.existing_code
          ? `\n\nExisting code to refactor/extend:\n\`\`\`python\n${args.existing_code}\n\`\`\``
          : "";

        const prompt = `You are an expert Blender Python developer. Write clean, correct Blender Python (bpy) code for the following task.

Task: ${args.task}${contextBlock}

Rules:
- Use the bpy module correctly (bpy.ops, bpy.context, bpy.data)
- Handle potential errors gracefully
- Include brief inline comments for non-obvious logic
- Respond with ONLY the Python code inside a single \`\`\`python ... \`\`\` block`;

        const raw = await ollamaGenerate(prompt, args.model ?? DEFAULT_MODEL);
        const fenceMatch = raw.match(/```(?:python)?\n?([\s\S]*?)\n?```/);
        const code = fenceMatch ? fenceMatch[1].trim() : raw.trim();

        let executeNote = "";
        if (args.execute_in_blender) {
          await sendToBlender("execute", { code });
          executeNote = "\n\n✅ Executed in Blender";
        }

        return text(`Generated Python code:\n\`\`\`python\n${code}\n\`\`\`${executeNote}`);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e.message ?? String(e));
  }
});

// ─────────────────────────────────────────────
// MCP Prompts — reusable, parameterised workflows
// ─────────────────────────────────────────────
const PROMPTS = [
  {
    name: "roblox_build_feature",
    description:
      "Plan and implement a Roblox Studio feature end-to-end using the studio_* tools.",
    arguments: [
      {
        name: "feature",
        description: "What the feature should do, in plain language.",
        required: true,
      },
      {
        name: "location",
        description:
          'Where the script should live, e.g. "game.ServerScriptService".',
        required: false,
      },
    ],
  },
  {
    name: "roblox_debug_script",
    description:
      "Diagnose and fix a misbehaving Roblox script using the read/output tools.",
    arguments: [
      {
        name: "script_path",
        description: 'Full path, e.g. "game.ServerScriptService.GameManager".',
        required: true,
      },
      {
        name: "symptom",
        description: "What is going wrong (error text or observed behaviour).",
        required: false,
      },
    ],
  },
  {
    name: "roblox_review_script",
    description:
      "Review a Roblox script for bugs, performance issues, and deprecated APIs.",
    arguments: [
      {
        name: "script_path",
        description: "Full path of the script to review.",
        required: true,
      },
      {
        name: "focus",
        description: 'Optional emphasis, e.g. "performance" or "security".',
        required: false,
      },
    ],
  },
  {
    name: "blender_build_scene",
    description:
      "Plan and build a Blender scene with bpy using the blender_* tools.",
    arguments: [
      {
        name: "description",
        description: "What the scene or model should contain.",
        required: true,
      },
    ],
  },
];

/** Wrap prompt text as a single user message. */
function userMessage(text) {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS,
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "roblox_build_feature":
      return {
        description: "Build a Roblox feature end-to-end.",
        ...userMessage(
          `Build this Roblox Studio feature: ${args.feature ?? "(unspecified)"}\n\n` +
            `Place the code in ${args.location || "an appropriate service"}.\n\n` +
            `Steps:\n` +
            `1. studio_status — confirm the plugin is connected.\n` +
            `2. studio_list_scripts — see what already exists.\n` +
            `3. Write modern Luau (game:GetService, task.wait — never wait()/spawn()/delay()).\n` +
            `4. studio_create_script / studio_write_script to apply the code.\n` +
            `5. studio_get_output — check for errors and fix any that appear.`
        ),
      };

    case "roblox_debug_script":
      return {
        description: "Debug a Roblox script.",
        ...userMessage(
          `Debug the Roblox script at ${args.script_path ?? "(unspecified)"}.\n\n` +
            (args.symptom ? `Reported symptom: ${args.symptom}\n\n` : "") +
            `Steps:\n` +
            `1. studio_read_script — read the current source.\n` +
            `2. studio_get_output — see recent errors/warnings.\n` +
            `3. Identify the root cause; do not patch symptoms.\n` +
            `4. studio_write_script — apply the corrected source.\n` +
            `5. studio_get_output — confirm the error is gone.`
        ),
      };

    case "roblox_review_script":
      return {
        description: "Review a Roblox script.",
        ...userMessage(
          `Review the Roblox script at ${args.script_path ?? "(unspecified)"}. ` +
            (args.focus
              ? `Focus on: ${args.focus}.`
              : "Cover bugs, performance, deprecated APIs, and style.") +
            `\n\nRead it with studio_read_script (or use the ollama_review_script ` +
            `tool), then report a one-line summary, issues by severity, and concrete fixes.`
        ),
      };

    case "blender_build_scene":
      return {
        description: "Build a Blender scene.",
        ...userMessage(
          `Build this in Blender: ${args.description ?? "(unspecified)"}\n\n` +
            `Steps:\n` +
            `1. blender_status — confirm the plugin is connected.\n` +
            `2. blender_get_scene_info — see what already exists.\n` +
            `3. blender_execute_python — run correct bpy code to build it.\n` +
            `4. blender_get_output — check for tracebacks and fix any.`
        ),
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// ─────────────────────────────────────────────
// MCP Resources — readable context data
// ─────────────────────────────────────────────
const guidePath = join(dirname(fileURLToPath(import.meta.url)), "..", "skills.md");

const RESOURCES = [
  {
    uri: "mcpbridge://guide",
    name: "MCPBridge agent skill guide",
    description:
      "How agents should drive MCPBridge — tools, workflows, and golden rules.",
    mimeType: "text/markdown",
  },
  {
    uri: "mcpbridge://server/info",
    name: "MCPBridge server info",
    description: "Server version, ports, default model, and capability counts.",
    mimeType: "application/json",
  },
  {
    uri: "mcpbridge://studio/status",
    name: "Roblox Studio connection status",
    description: "Live connection state of the Roblox Studio plugin.",
    mimeType: "application/json",
  },
  {
    uri: "mcpbridge://studio/output",
    name: "Roblox Studio output log",
    description: "Recent print/warn/error lines captured from Roblox Studio.",
    mimeType: "text/plain",
  },
  {
    uri: "mcpbridge://blender/status",
    name: "Blender connection status",
    description: "Live connection state of the Blender plugin.",
    mimeType: "application/json",
  },
  {
    uri: "mcpbridge://blender/output",
    name: "Blender output log",
    description: "Recent log lines captured from Blender.",
    mimeType: "text/plain",
  },
];

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  const json = (obj) => ({
    contents: [
      { uri, mimeType: "application/json", text: JSON.stringify(obj, null, 2) },
    ],
  });
  const body = (txt, mimeType = "text/plain") => ({
    contents: [{ uri, mimeType, text: txt }],
  });

  switch (uri) {
    case "mcpbridge://guide":
      try {
        return body(readFileSync(guidePath, "utf8"), "text/markdown");
      } catch {
        return body(
          "Agent skill guide unavailable — see skills.md in the MCPBridge repository.",
          "text/markdown"
        );
      }

    case "mcpbridge://server/info":
      return json({
        name: "mcpbridge",
        version: "1.0.0",
        robloxPort: ROBLOX_PORT,
        blenderPort: BLENDER_PORT,
        ollamaBase: OLLAMA_BASE,
        defaultModel: DEFAULT_MODEL,
        tools: 17,
        prompts: PROMPTS.length,
        resources: RESOURCES.length,
      });

    case "mcpbridge://studio/status":
      return json({
        connected: isStudioConnected(),
        lastSeen: studioState.lastSeen,
        queueLength: commandQueue.length,
        scriptCount: studioState.scripts.length,
      });

    case "mcpbridge://studio/output":
      return body(
        studioState.output.slice(-200).join("\n") || "(no output captured yet)"
      );

    case "mcpbridge://blender/status":
      return json({
        connected: isBlenderConnected(),
        lastSeen: blenderState.lastSeen,
        queueLength: blenderCommandQueue.length,
        objectCount: blenderState.objects.length,
      });

    case "mcpbridge://blender/output":
      return body(
        blenderState.output.slice(-200).join("\n") || "(no output captured yet)"
      );

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// Connect MCP transport
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[MCP Bridge] MCP server connected via stdio\n");
