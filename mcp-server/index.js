/**
 * Roblox-Ollama MCP Bridge Server
 * ─────────────────────────────────
 * Speaks MCP (stdio) to Claude Code while running an HTTP server
 * that the Roblox Studio plugin polls for commands.
 *
 * Ollama model: minimax-m2.5:cloud
 * HTTP bridge port: 7842
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";

// ─────────────────────────────────────────────
// HTTP bridge server (for Roblox Studio plugin)
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const BRIDGE_PORT = 7842;
const OLLAMA_BASE = "http://localhost:11434";
const DEFAULT_MODEL = "minimax-m2.5:cloud";

// Shared state
const commandQueue = []; // Commands waiting to be picked up by plugin
const resultStore = new Map(); // commandId → { result, error }
const studioState = {
  connected: false,
  lastSeen: null,
  scripts: [],
  output: [],
  metadata: {},
};

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

// ── Health check ──
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

app.listen(BRIDGE_PORT, "127.0.0.1", () => {
  process.stderr.write(
    `[MCP Bridge] HTTP server listening on http://127.0.0.1:${BRIDGE_PORT}\n`
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
  // Remove stale command from queue
  const idx = commandQueue.findIndex((c) => c.id === commandId);
  if (idx !== -1) commandQueue.splice(idx, 1);
  throw new Error(
    "Command timed out — is the Roblox Studio plugin connected and active?"
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
  { name: "roblox-ollama-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
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

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e.message ?? String(e));
  }
});

// Connect MCP transport
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[MCP Bridge] MCP server connected via stdio\n");
