#!/usr/bin/env node
/**
 * MCPBridge - unified MCP server
 *
 *   Agent (MCP over stdio)
 *        |
 *   this server --- HTTP 127.0.0.1:7842 ---> Roblox Studio plugin (Lua)
 *        |--------- HTTP 127.0.0.1:7843 ---> Blender add-on (Python)
 *        '--------- HTTP localhost:11434 --> Ollama
 *
 * No dependencies: it runs with Node.js alone, there is nothing to `npm install`.
 *
 * Several agent sessions can be open at once. The first server owns the two HTTP
 * ports; every later one notices the ports are taken and relays its commands
 * through the owner, then takes the ports over when the owner goes away. A server
 * exits as soon as its agent closes, so no leftover process keeps the ports and
 * leaves the plugin "connected" to nobody.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VERSION = "1.1.0";
const ROBLOX_PORT = Number(process.env.MCPBRIDGE_ROBLOX_PORT) || 7842;
const BLENDER_PORT = Number(process.env.MCPBRIDGE_BLENDER_PORT) || 7843;
const HOST = "127.0.0.1";
const OLLAMA_BASE = process.env.OLLAMA_HOST_URL || "http://localhost:11434";
const DEFAULT_MODEL = process.env.MCPBRIDGE_MODEL || "minimax-m2.5:cloud";

const CONNECTED_WINDOW_MS = 8_000;   // a plugin that polled this recently is connected
const POLL_HOLD_MS = 3_000;          // how long an idle poll is held open (long poll)
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;
const WAIT_FOR_PLUGIN_MS = 6_000;    // grace for a plugin that is just starting
const TAKEOVER_RETRY_MS = 4_000;
const OUTPUT_KEPT = 2_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const log = (message) => process.stderr.write(`[MCPBridge] ${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────
// One bridge per application
// ─────────────────────────────────────────────

class Bridge {
  /**
   * @param {string} app     Short name used in messages ("Roblox Studio").
   * @param {number} port    Local port the plugin polls.
   * @param {string} howTo   What the user has to do to connect the plugin.
   */
  constructor(app, port, howTo) {
    this.app = app;
    this.port = port;
    this.howTo = howTo;
    this.mode = "starting";            // "owner" | "relay" | "blocked"
    this.blockedBy = "";
    this.lastSeen = 0;
    this.pluginVersion = null;
    this.queue = [];                   // commands waiting for the plugin
    this.pollers = [];                 // held-open polls: { res, timer }
    this.pending = new Map();          // commandId -> { resolve, reject, timer }
    this.output = [];
    this.metadata = {};
    this.server = null;
    this.retryTimer = null;
  }

  get base() {
    return `http://${HOST}:${this.port}`;
  }

  // ── owning the port ──

  start() {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => this.reply(res, 500, { ok: false, error: String(error?.message ?? error) }));
    });
    server.on("error", async (error) => {
      if (error.code !== "EADDRINUSE") {
        this.mode = "blocked";
        this.blockedBy = `could not open port ${this.port}: ${error.message}`;
        log(`${this.app}: ${this.blockedBy}`);
      } else {
        await this.lookAtOwner();
      }
      this.retryLater();
    });
    server.listen(this.port, HOST, () => {
      this.server = server;
      this.mode = "owner";
      this.blockedBy = "";
      log(`${this.app} bridge listening on ${this.base}`);
    });
  }

  retryLater() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), TAKEOVER_RETRY_MS);
    this.retryTimer.unref?.();
  }

  /** Someone else has the port: another MCPBridge we can relay through, or not. */
  async lookAtOwner() {
    const health = await this.ownerGet("/health");
    const was = this.mode;
    if (health?.relay) {
      this.mode = "relay";
      this.blockedBy = "";
      if (was !== "relay") log(`${this.app}: another MCPBridge session owns port ${this.port}, relaying through it`);
    } else if (health?.bridge === "ok") {
      this.mode = "blocked";
      this.blockedBy =
        `port ${this.port} is held by an older MCPBridge server left over from another session. ` +
        `Close your other AI coding sessions (or end the leftover "node" process in Task Manager); ` +
        `this session takes over automatically within a few seconds.`;
      if (was !== "blocked") log(`${this.app}: ${this.blockedBy}`);
    } else {
      this.mode = "blocked";
      this.blockedBy = `port ${this.port} is in use by another program, so the ${this.app} plugin cannot reach this server.`;
      if (was !== "blocked") log(`${this.app}: ${this.blockedBy}`);
    }
  }

  async ownerGet(path) {
    try {
      const res = await fetch(this.base + path, { signal: AbortSignal.timeout(2_000) });
      return await res.json();
    } catch {
      return null;
    }
  }

  stop() {
    clearTimeout(this.retryTimer);
    for (const poller of this.pollers.splice(0)) {
      clearTimeout(poller.timer);
      this.reply(poller.res, 200, { hasCommand: false });
    }
    this.server?.close();
    this.server?.closeAllConnections?.();
  }

  // ── HTTP side (the plugin, and other MCPBridge sessions) ──

  reply(res, status, body) {
    if (res.writableEnded) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(text),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(text);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error("Request body is not valid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url, this.base);
    const route = `${req.method} ${url.pathname}`;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    switch (route) {
      case "GET /poll": {
        this.lastSeen = Date.now();
        const version = url.searchParams.get("v");
        if (version) this.pluginVersion = version;
        if (this.queue.length > 0) {
          return this.reply(res, 200, { hasCommand: true, command: this.queue.shift() });
        }
        // Hold the poll open so the next command reaches the plugin at once.
        const poller = { res, timer: null };
        const release = () => {
          clearTimeout(poller.timer);
          const at = this.pollers.indexOf(poller);
          if (at !== -1) this.pollers.splice(at, 1);
        };
        poller.timer = setTimeout(() => {
          release();
          this.lastSeen = Date.now();
          this.reply(res, 200, { hasCommand: false });
        }, POLL_HOLD_MS);
        res.on("close", release);
        this.pollers.push(poller);
        return;
      }

      case "POST /result": {
        const { commandId, result, error } = await this.readBody(req);
        this.lastSeen = Date.now();
        const waiting = this.pending.get(commandId);
        if (waiting) {
          this.pending.delete(commandId);
          clearTimeout(waiting.timer);
          if (error) waiting.reject(new Error(String(error)));
          else waiting.resolve(result);
        }
        return this.reply(res, 200, { ok: true });
      }

      case "POST /state": {
        const { output, metadata } = await this.readBody(req);
        this.lastSeen = Date.now();
        if (Array.isArray(output)) this.addOutput(output);
        if (metadata && typeof metadata === "object") this.metadata = { ...this.metadata, ...metadata };
        return this.reply(res, 200, { ok: true });
      }

      case "GET /health":
        return this.reply(res, 200, {
          bridge: "ok",
          version: VERSION,
          relay: true,
          connected: this.pluginConnected(),
          // Older plugins and tools read these two names.
          studioConnected: this.pluginConnected(),
          blenderConnected: this.pluginConnected(),
          lastSeen: this.lastSeen || null,
          pluginVersion: this.pluginVersion,
          queueLength: this.queue.length,
          metadata: this.metadata,
        });

      // Another MCPBridge session asking the port owner to run a command for it.
      case "POST /command": {
        const { type, payload, timeoutMs } = await this.readBody(req);
        try {
          const result = await this.run(String(type), payload ?? {}, Number(timeoutMs) || DEFAULT_TIMEOUT_S * 1000);
          return this.reply(res, 200, { ok: true, result: result ?? null });
        } catch (error) {
          return this.reply(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      case "GET /output": {
        const lines = Number(url.searchParams.get("lines")) || 100;
        return this.reply(res, 200, { lines: this.output.slice(-lines) });
      }

      default:
        return this.reply(res, 404, { ok: false, error: `No such endpoint: ${route}` });
    }
  }

  addOutput(lines) {
    for (const line of lines) this.output.push(String(line));
    if (this.output.length > OUTPUT_KEPT) this.output.splice(0, this.output.length - OUTPUT_KEPT);
  }

  pluginConnected() {
    return this.pollers.length > 0 || (this.lastSeen > 0 && Date.now() - this.lastSeen < CONNECTED_WINDOW_MS);
  }

  // ── agent side ──

  /** Where this session stands, in words an agent can pass on to the user. */
  async status() {
    if (this.mode === "starting") await sleep(300);
    if (this.mode === "relay") {
      const health = await this.ownerGet("/health");
      if (!health) {
        await this.lookAtOwner();
        return { connected: false, mode: this.mode, note: "The session that owned the port just closed; taking over. Try again in a few seconds." };
      }
      return { connected: !!health.connected, mode: "relay", lastSeen: health.lastSeen, pluginVersion: health.pluginVersion, metadata: health.metadata ?? {} };
    }
    if (this.mode === "blocked") return { connected: false, mode: "blocked", note: this.blockedBy };
    return { connected: this.pluginConnected(), mode: this.mode, lastSeen: this.lastSeen || null, pluginVersion: this.pluginVersion, metadata: this.metadata };
  }

  notConnectedMessage() {
    return `The ${this.app} plugin is not connected to MCPBridge.\n${this.howTo}`;
  }

  /** Run one command in the application and return its result. */
  async send(type, payload = {}, timeoutSeconds = DEFAULT_TIMEOUT_S) {
    const seconds = Math.min(Math.max(Number(timeoutSeconds) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
    const timeoutMs = seconds * 1000;
    if (this.mode === "starting") await sleep(300);
    if (this.mode === "blocked") await this.lookAtOwner();
    if (this.mode === "blocked") throw new Error(`Cannot reach ${this.app}: ${this.blockedBy}`);

    if (this.mode === "relay") {
      let answer;
      try {
        const res = await fetch(this.base + "/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, payload, timeoutMs }),
          signal: AbortSignal.timeout(timeoutMs + 10_000),
        });
        answer = await res.json();
      } catch (error) {
        // The owner went away mid-flight; become the owner and tell the agent to retry.
        clearTimeout(this.retryTimer);
        this.start();
        throw new Error(`The MCPBridge session that owned port ${this.port} closed (${error.message}). This session is taking over; run the tool again in a few seconds.`);
      }
      if (!answer.ok) throw new Error(answer.error || "Command failed");
      return answer.result;
    }

    return this.run(type, payload, timeoutMs);
  }

  /** Owner only: queue a command for the plugin and wait for its result. */
  async run(type, payload, timeoutMs) {
    // Fail fast with a useful message instead of a long timeout when no plugin is there.
    const deadline = Date.now() + WAIT_FOR_PLUGIN_MS;
    while (!this.pluginConnected() && Date.now() < deadline) await sleep(200);
    if (!this.pluginConnected()) throw new Error(this.notConnectedMessage());

    const id = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const command = { id, type, payload };
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const at = this.queue.indexOf(command);
        if (at !== -1) this.queue.splice(at, 1);
        reject(new Error(
          this.pluginConnected()
            ? `${this.app} did not answer "${type}" within ${Math.round(timeoutMs / 1000)} s. It may still be running; pass a larger timeout_seconds for long jobs.`
            : this.notConnectedMessage()
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    const poller = this.pollers.shift();
    if (poller) {
      clearTimeout(poller.timer);
      this.reply(poller.res, 200, { hasCommand: true, command });
    } else {
      this.queue.push(command);
    }
    return result;
  }

  async recentOutput(lines) {
    if (this.mode === "relay") {
      const answer = await this.ownerGet(`/output?lines=${lines}`);
      return answer?.lines ?? [];
    }
    return this.output.slice(-lines);
  }
}

const studio = new Bridge(
  "Roblox Studio",
  ROBLOX_PORT,
  [
    "To connect it:",
    "1. Open Roblox Studio with a place loaded.",
    '2. Click "MCP Bridge" in the Plugins tab so its window says Connected.',
    "3. If the button is missing, copy roblox-plugin/OllamaMCP.lua into Studio's plugin folder (Plugins > Plugins Folder) and restart Studio.",
    "4. If Studio asks whether the plugin may make HTTP requests to 127.0.0.1, allow it.",
  ].join("\n")
);

const blender = new Bridge(
  "Blender",
  BLENDER_PORT,
  [
    "To connect it:",
    "1. Open Blender.",
    "2. In a 3D Viewport press N, open the MCPBridge tab and click Start Bridge.",
    "3. If the tab is missing, install blender-plugin/MCPBridge.py under Edit > Preferences > Add-ons > Install from Disk and enable it.",
  ].join("\n")
);

// ─────────────────────────────────────────────
// Ollama
// ─────────────────────────────────────────────

async function ollama(path, body) {
  let res;
  try {
    res = await fetch(`${OLLAMA_BASE}${path}`, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
  } catch (error) {
    throw new Error(`Ollama is not reachable at ${OLLAMA_BASE} (${error.cause?.code ?? error.message}). Start Ollama first. The studio_* and blender_* tools work without it.`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama error ${res.status}: ${detail}`);
  }
  return res.json();
}

async function ollamaGenerate(prompt, { model, system, options } = {}) {
  const data = await ollama("/api/generate", { model: model || DEFAULT_MODEL, prompt, system, options, stream: false });
  return data.response ?? "";
}

function stripCodeFences(text) {
  const match = text.match(/```[a-zA-Z]*\n?([\s\S]*?)\n?```/);
  return (match ? match[1] : text).trim();
}

// ─────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });
const schema = (properties = {}, required = []) => ({ type: "object", properties, required });

const TIMEOUT = num(`Seconds to wait for the result (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Raise it for long jobs.`);
const PATH_HELP = 'Instance path such as "game.Workspace.Model.Part" or "game.ServerScriptService.Main". Services are found by name.';
const VALUE_HELP =
  "Values are plain JSON and are converted to the property's own type: Vector3 [x,y,z], Vector2 [x,y], " +
  'Color3 "#RRGGBB" or [r,g,b] (0-255), CFrame {"position":[x,y,z],"rotation":[rx,ry,rz]} in degrees (or just [x,y,z] to move it), ' +
  'UDim2 [xScale,xOffset,yScale,yOffset], enums by name ("Neon"), BrickColor by name, instances by path.';

const pretty = (value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** Result of running code in an application: return values, printed output, error. */
function describeRun(result) {
  if (result === null || result === undefined) return { text: "Executed (no return value)." };
  if (typeof result !== "object" || Array.isArray(result) || !("ok" in result)) {
    return { text: `Result: ${pretty(result)}` };   // older plugins return the bare value
  }
  const parts = [];
  if (result.ok) {
    const values = result.values ?? (result.value === undefined ? [] : [result.value]);
    if (values.length === 0) parts.push("Executed (no return value).");
    else parts.push(`Result: ${pretty(values.length === 1 ? values[0] : values)}`);
  } else {
    parts.push(`Error: ${result.error}`);
  }
  if (Array.isArray(result.output) && result.output.length > 0) parts.push(`Output:\n${result.output.join("\n")}`);
  return { text: parts.join("\n\n"), isError: !result.ok };
}

async function statusText(bridge) {
  const status = await bridge.status();
  if (status.connected) {
    const seen = status.lastSeen ? `${Math.max(0, Math.round((Date.now() - status.lastSeen) / 1000))} s ago` : "just now";
    const extras = [
      status.pluginVersion ? `plugin v${status.pluginVersion}` : "plugin v1.0 (update the plugin file for the newer tools)",
      status.mode === "relay" ? "shared with another open session" : null,
    ].filter(Boolean).join(", ");
    return `${bridge.app} is CONNECTED (last seen ${seen}; ${extras}).${Object.keys(status.metadata ?? {}).length ? `\n${pretty(status.metadata)}` : ""}`;
  }
  return `${bridge.app} is NOT connected.\n${status.note ? `${status.note}\n` : ""}${status.mode === "blocked" ? "" : bridge.howTo}`;
}

const TOOLS = [
  // ───────── Roblox Studio ─────────
  {
    name: "studio_status",
    description: "Check whether the Roblox Studio plugin is connected, and what to do if it is not.",
    inputSchema: schema(),
    run: () => statusText(studio),
  },
  {
    name: "studio_execute_lua",
    description:
      "Run any Luau code inside Roblox Studio with full plugin permissions: build or edit instances, read or change any property, " +
      "call any service, rewrite scripts, import assets. Use `return` to get values back (instances come back as paths, tables as JSON). " +
      "Everything printed while it runs is returned too. This is the most flexible Studio tool: use it for anything the other tools do not cover.",
    inputSchema: schema({ code: str("Luau source to run. May use return."), timeout_seconds: TIMEOUT }, ["code"]),
    run: async (a) => describeRun(await studio.send("execute", { code: a.code }, a.timeout_seconds)),
  },
  {
    name: "studio_get_tree",
    description: "Show the instance tree under a path (names and classes), to explore how a place is built.",
    inputSchema: schema({
      path: str(`${PATH_HELP} Default: game.`),
      depth: num("How many levels below the path to show (default 2)."),
      limit: num("Most instances to list (default 400)."),
    }),
    run: async (a) => {
      const tree = await studio.send("get_tree", { path: a.path ?? "game", depth: a.depth ?? 2, limit: a.limit ?? 400 });
      const lines = (tree.nodes ?? []).map((n) => `${"  ".repeat(n.depth)}${n.name} [${n.class}]${n.children ? ` (${n.children} children)` : ""}`);
      return `${tree.root}\n${lines.join("\n")}${tree.truncated ? "\n... (limit reached; raise limit or pick a deeper path)" : ""}`;
    },
  },
  {
    name: "studio_find_instances",
    description: "Search the place for instances by name and/or class.",
    inputSchema: schema({
      name: str("Text the name must contain (case-insensitive). Optional."),
      class_name: str('Class the instance must be, including subclasses, e.g. "BasePart", "Script", "RemoteEvent". Optional.'),
      root: str(`Where to search. ${PATH_HELP} Default: game.`),
      limit: num("Most results (default 200)."),
    }),
    run: async (a) => {
      const found = await studio.send("find", { name: a.name, class_name: a.class_name, root: a.root ?? "game", limit: a.limit ?? 200 });
      const items = found.items ?? [];
      if (items.length === 0) return "No matching instances.";
      return `Found ${items.length}${found.truncated ? "+ (limit reached)" : ""}:\n${items.map((i) => `  ${i.path} [${i.class}]`).join("\n")}`;
    },
  },
  {
    name: "studio_get_properties",
    description: "Read an instance's properties, attributes and tags.",
    inputSchema: schema({
      path: str(PATH_HELP),
      properties: { type: "array", items: { type: "string" }, description: "Only these property names. Default: every readable property." },
    }, ["path"]),
    run: async (a) => pretty(await studio.send("get_properties", { path: a.path, properties: a.properties })),
  },
  {
    name: "studio_set_properties",
    description: `Change properties, attributes and tags of one or more instances. One undo step. ${VALUE_HELP}`,
    inputSchema: schema({
      path: str(`${PATH_HELP} Use paths instead to change several at once.`),
      paths: { type: "array", items: { type: "string" }, description: "Several instance paths that all get the same changes." },
      properties: { type: "object", description: 'Property name to new value, e.g. {"Anchored": true, "Size": [4,1,2], "Material": "Neon", "Name": "Floor", "Parent": "game.Workspace.Map"}.' },
      attributes: { type: "object", description: "Attribute name to value." },
      add_tags: { type: "array", items: { type: "string" }, description: "CollectionService tags to add." },
      remove_tags: { type: "array", items: { type: "string" }, description: "CollectionService tags to remove." },
    }),
    run: async (a) => pretty(await studio.send("set_properties", a)),
  },
  {
    name: "studio_create_instance",
    description: `Create an instance of any class (Part, Model, Folder, RemoteEvent, ScreenGui, TextLabel, ...), with properties and children. One undo step. ${VALUE_HELP}`,
    inputSchema: schema({
      class_name: str('Roblox class to create, e.g. "Part".'),
      parent_path: str(`Where to put it. ${PATH_HELP}`),
      name: str("Name of the new instance. Optional."),
      properties: { type: "object", description: "Property name to value, applied before parenting." },
      attributes: { type: "object", description: "Attribute name to value." },
      children: { type: "array", items: { type: "object" }, description: "Nested instances to create inside it, each {class_name, name?, properties?, attributes?, children?}." },
    }, ["class_name", "parent_path"]),
    run: async (a) => `Created ${pretty(await studio.send("create_instance", a))}`,
  },
  {
    name: "studio_delete_instance",
    description: "Delete one or more instances (undoable with studio_undo).",
    inputSchema: schema({
      path: str(PATH_HELP),
      paths: { type: "array", items: { type: "string" }, description: "Several instance paths." },
    }),
    run: async (a) => `Deleted ${pretty(await studio.send("delete_instance", a))}`,
  },
  {
    name: "studio_clone_instance",
    description: "Copy an instance (with everything inside it), optionally into another parent and under a new name.",
    inputSchema: schema({
      path: str(PATH_HELP),
      new_parent_path: str("Where the copy goes. Default: next to the original."),
      name: str("Name for the copy. Optional."),
      properties: { type: "object", description: "Properties to set on the copy." },
    }, ["path"]),
    run: async (a) => `Cloned to ${pretty(await studio.send("clone_instance", a))}`,
  },
  {
    name: "studio_move_instance",
    description: "Move an instance to another parent and/or rename it.",
    inputSchema: schema({
      path: str(PATH_HELP),
      new_parent_path: str("New parent. Optional."),
      name: str("New name. Optional."),
    }, ["path"]),
    run: async (a) => `Now at ${pretty(await studio.send("move_instance", a))}`,
  },
  {
    name: "studio_insert_asset",
    description: "Insert a Roblox asset (model, mesh, audio, plugin-free marketplace item) by asset id.",
    inputSchema: schema({
      asset_id: { type: ["number", "string"], description: "Numeric asset id or an rbxassetid:// URL." },
      parent_path: str("Where to put it. Default: game.Workspace."),
    }, ["asset_id"]),
    run: async (a) => `Inserted ${pretty(await studio.send("insert_asset", a, 120))}`,
  },
  {
    name: "studio_list_scripts",
    description: "List every script in the place with its path, class and line count.",
    inputSchema: schema({ root: str(`Only scripts under this path. ${PATH_HELP} Default: the whole place.`) }),
    run: async (a) => {
      const scripts = await studio.send("list_scripts", { root: a.root });
      if (!Array.isArray(scripts) || scripts.length === 0) return "No scripts found.";
      return `Found ${scripts.length} scripts:\n${scripts.map((s) => `  [${s.type}] ${s.path}${s.lines ? ` (${s.lines} lines)` : ""}${s.disabled ? " (disabled)" : ""}`).join("\n")}`;
    },
  },
  {
    name: "studio_read_script",
    description: "Read a script's source.",
    inputSchema: schema({ path: str(PATH_HELP) }, ["path"]),
    run: async (a) => `-- Source: ${a.path}\n\`\`\`lua\n${await studio.send("read_script", { path: a.path })}\n\`\`\``,
  },
  {
    name: "studio_write_script",
    description: "Replace a script's whole source. Creates the script if it does not exist yet.",
    inputSchema: schema({
      path: str(PATH_HELP),
      source: str("The full new source."),
      script_type: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], description: "Class used if the script has to be created (default Script)." },
    }, ["path", "source"]),
    run: async (a) => `Wrote ${pretty(await studio.send("write_script", { path: a.path, source: a.source, script_type: a.script_type, create: true }))}`,
  },
  {
    name: "studio_edit_script",
    description: "Change part of a script without resending all of it: replaces an exact piece of text with new text.",
    inputSchema: schema({
      path: str(PATH_HELP),
      old_text: str("Exact text to find (must be in the script)."),
      new_text: str("Text to put in its place."),
      replace_all: bool("Replace every occurrence instead of requiring exactly one (default false)."),
    }, ["path", "old_text", "new_text"]),
    run: async (a) => {
      const done = await studio.send("edit_script", a);
      return `Replaced ${done.count} occurrence(s) in ${a.path}.`;
    },
  },
  {
    name: "studio_create_script",
    description: "Create a new Script, LocalScript or ModuleScript.",
    inputSchema: schema({
      parent_path: str(`Where to put it. ${PATH_HELP}`),
      name: str("Name of the script."),
      script_type: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], description: "Default Script." },
      source: str("Initial source. Optional."),
      run_context: { type: "string", enum: ["Legacy", "Server", "Client"], description: "RunContext for a Script. Optional." },
    }, ["parent_path", "name"]),
    run: async (a) => `Created ${a.script_type ?? "Script"} at ${pretty(await studio.send("create_script", { ...a, script_type: a.script_type ?? "Script", source: a.source ?? "" }))}`,
  },
  {
    name: "studio_get_output",
    description: "Recent lines from Studio's Output window (prints, warnings, errors), newest last.",
    inputSchema: schema({ lines: num("How many lines (default 100)."), filter: str("Only lines containing this text. Optional.") }),
    run: async (a) => {
      let lines = await studio.recentOutput(a.filter ? OUTPUT_KEPT : (a.lines ?? 100));
      if (a.filter) lines = lines.filter((l) => l.toLowerCase().includes(String(a.filter).toLowerCase())).slice(-(a.lines ?? 100));
      return lines.length > 0 ? `Last ${lines.length} output lines:\n\n${lines.join("\n")}` : "(No output captured yet. Output is collected while the plugin is connected.)";
    },
  },
  {
    name: "studio_get_workspace_info",
    description: "Place name and ids, script and instance counts, whether a playtest is running.",
    inputSchema: schema(),
    run: async () => pretty(await studio.send("workspace_info", {})),
  },
  {
    name: "studio_get_selection",
    description: "What is selected in the Explorer right now.",
    inputSchema: schema(),
    run: async () => {
      const selection = await studio.send("get_selection", {});
      if (!Array.isArray(selection) || selection.length === 0) return "Nothing is selected.";
      return `Selected ${selection.length} instance(s):\n${selection.map((s) => `  ${s.path} [${s.className}]`).join("\n")}`;
    },
  },
  {
    name: "studio_set_selection",
    description: "Select instances in the Explorer (and so in the viewport), to show the user what was changed.",
    inputSchema: schema({ paths: { type: "array", items: { type: "string" }, description: "Instance paths to select. Empty clears the selection." } }, ["paths"]),
    run: async (a) => `Selected ${pretty(await studio.send("set_selection", { paths: a.paths }))}`,
  },
  {
    name: "studio_undo",
    description: "Undo the last change in Studio (the same as Ctrl+Z). Every MCPBridge change is one undo step.",
    inputSchema: schema({ steps: num("How many steps (default 1).") }),
    run: async (a) => `Undid ${pretty(await studio.send("undo", { steps: a.steps ?? 1 }))} step(s).`,
  },
  {
    name: "studio_redo",
    description: "Redo the last undone change in Studio.",
    inputSchema: schema({ steps: num("How many steps (default 1).") }),
    run: async (a) => `Redid ${pretty(await studio.send("redo", { steps: a.steps ?? 1 }))} step(s).`,
  },

  // ───────── Blender ─────────
  {
    name: "blender_status",
    description: "Check whether the Blender add-on is connected, and what to do if it is not.",
    inputSchema: schema(),
    run: () => statusText(blender),
  },
  {
    name: "blender_execute_python",
    description:
      "Run any Python inside Blender with the full bpy API: model, edit meshes, materials, modifiers, animation, import and export files, render. " +
      "The value of the last expression (or a variable named __result__) is returned, along with everything printed. " +
      "This is the most flexible Blender tool: use it for anything the other tools do not cover.",
    inputSchema: schema({ code: str("Python source to run. bpy is already imported."), timeout_seconds: TIMEOUT }, ["code"]),
    run: async (a) => describeRun(await blender.send("execute", { code: a.code }, a.timeout_seconds)),
  },
  {
    name: "blender_get_scene_info",
    description: "Objects in the scene, the active object, render engine and frame range.",
    inputSchema: schema(),
    run: async () => pretty(await blender.send("scene_info", {})),
  },
  {
    name: "blender_get_object",
    description: "Details of one object: transform, dimensions, mesh counts, materials, modifiers, parent and children.",
    inputSchema: schema({ name: str("Object name.") }, ["name"]),
    run: async (a) => pretty(await blender.send("object_info", { name: a.name })),
  },
  {
    name: "blender_get_output",
    description: "Recent lines printed by code run through MCPBridge in Blender, newest last.",
    inputSchema: schema({ lines: num("How many lines (default 100).") }),
    run: async (a) => {
      const lines = await blender.recentOutput(a.lines ?? 100);
      return lines.length > 0 ? `Last ${lines.length} output lines:\n\n${lines.join("\n")}` : "(No output captured yet.)";
    },
  },
  {
    name: "blender_list_texts",
    description: "List the text blocks (scripts) stored in the .blend file.",
    inputSchema: schema(),
    run: async () => pretty(await blender.send("list_scripts", {})),
  },
  {
    name: "blender_read_text",
    description: "Read a text block from the .blend file.",
    inputSchema: schema({ name: str("Text block name.") }, ["name"]),
    run: async (a) => String(await blender.send("read_script", { path: a.name })),
  },
  {
    name: "blender_write_text",
    description: "Create or replace a text block in the .blend file.",
    inputSchema: schema({ name: str("Text block name."), source: str("Its full content.") }, ["name", "source"]),
    run: async (a) => {
      await blender.send("write_script", { path: a.name, source: a.source });
      return `Wrote text block ${a.name}.`;
    },
  },

  // ───────── Ollama ─────────
  {
    name: "ollama_list_models",
    description: "List the models available in the local Ollama.",
    inputSchema: schema(),
    run: async () => {
      const data = await ollama("/api/tags");
      const models = (data.models ?? []).map((m) => `  ${m.name}`);
      return models.length ? `Models:\n${models.join("\n")}` : "Ollama has no models yet.";
    },
  },
  {
    name: "ollama_generate",
    description: "Send any prompt to an Ollama model and return its answer.",
    inputSchema: schema({
      prompt: str("The prompt."),
      system: str("System prompt. Optional."),
      model: str(`Model (default ${DEFAULT_MODEL}).`),
      options: { type: "object", description: "Ollama options such as temperature or num_ctx. Optional." },
    }, ["prompt"]),
    run: (a) => ollamaGenerate(a.prompt, a),
  },
  {
    name: "ollama_generate_lua",
    description: "Have an Ollama model write Roblox Luau for a task, optionally writing it straight into a script in Studio.",
    inputSchema: schema({
      task: str("What the code should do."),
      existing_code: str("Code to refactor or extend. Optional."),
      apply_to: str("Script path to write the result to (created if missing). Optional."),
      model: str(`Model (default ${DEFAULT_MODEL}).`),
    }, ["task"]),
    run: async (a) => {
      const context = a.existing_code ? `\n\nExisting code to refactor or extend:\n\`\`\`lua\n${a.existing_code}\n\`\`\`` : "";
      const code = stripCodeFences(await ollamaGenerate(
        `You are an expert Roblox Luau developer. Write clean, production-ready code for this task.\n\nTask: ${a.task}${context}\n\n` +
        "Rules:\n- Use modern APIs (game:GetService, task.wait, task.spawn).\n- Never use wait(), spawn() or delay().\n" +
        "- Brief comments only where the logic is not obvious.\n- Answer with ONLY the code in one ```lua block.",
        a
      ));
      let note = "";
      if (a.apply_to) {
        await studio.send("write_script", { path: a.apply_to, source: code, create: true });
        note = `\n\nWritten to ${a.apply_to}`;
      }
      return `Generated Lua:\n\`\`\`lua\n${code}\n\`\`\`${note}`;
    },
  },
  {
    name: "ollama_review_script",
    description: "Have an Ollama model review a script in Studio for bugs, performance and deprecated APIs.",
    inputSchema: schema({
      path: str(PATH_HELP),
      focus: str('What to concentrate on, e.g. "performance". Optional.'),
      model: str(`Model (default ${DEFAULT_MODEL}).`),
    }, ["path"]),
    run: async (a) => {
      const source = await studio.send("read_script", { path: a.path });
      const review = await ollamaGenerate(
        `You are a senior Roblox Luau engineer. Review this script and give actionable feedback. ` +
        `${a.focus ? `Focus on: ${a.focus}.` : "Cover bugs, performance, deprecated APIs and style."}\n\n` +
        `Script: ${a.path}\n\`\`\`lua\n${source}\n\`\`\`\n\n` +
        "Sections: 1. Summary (1-2 sentences). 2. Issues (each with severity Critical / Warning / Info). 3. Suggested fixes with code.",
        a
      );
      return `# Code review: ${a.path}\n\n${review}`;
    },
  },
  {
    name: "ollama_generate_python",
    description: "Have an Ollama model write Blender Python for a task, optionally running it in Blender.",
    inputSchema: schema({
      task: str("What the code should do."),
      existing_code: str("Code to refactor or extend. Optional."),
      execute_in_blender: bool("Run the result in Blender (default false)."),
      model: str(`Model (default ${DEFAULT_MODEL}).`),
    }, ["task"]),
    run: async (a) => {
      const context = a.existing_code ? `\n\nExisting code to refactor or extend:\n\`\`\`python\n${a.existing_code}\n\`\`\`` : "";
      const code = stripCodeFences(await ollamaGenerate(
        `You are an expert Blender Python developer. Write correct bpy code for this task.\n\nTask: ${a.task}${context}\n\n` +
        "Rules:\n- Use bpy.data and bpy.context correctly; prefer bpy.data over bpy.ops where possible.\n" +
        "- Brief comments only where the logic is not obvious.\n- Answer with ONLY the code in one ```python block.",
        a
      ));
      let note = "";
      if (a.execute_in_blender) {
        const run = describeRun(await blender.send("execute", { code }, 120));
        note = `\n\n${run.isError ? "Running it in Blender failed" : "Ran in Blender"}:\n${run.text}`;
      }
      return `Generated Python:\n\`\`\`python\n${code}\n\`\`\`${note}`;
    },
  },
];

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `Error: unknown tool "${name}".` }], isError: true };
  try {
    const out = await tool.run(args ?? {});
    const text = typeof out === "string" ? out : out.text;
    return { content: [{ type: "text", text }], ...(typeof out === "object" && out.isError ? { isError: true } : {}) };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error?.message ?? error}` }], isError: true };
  }
}

// ─────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────

const PROMPTS = [
  {
    name: "roblox_build_feature",
    description: "Plan and build a Roblox Studio feature end to end.",
    arguments: [
      { name: "feature", description: "What the feature should do, in plain language.", required: true },
      { name: "location", description: 'Where the code should live, e.g. "game.ServerScriptService".', required: false },
    ],
    text: (a) =>
      `Build this Roblox Studio feature: ${a.feature ?? "(unspecified)"}\n\nPut the code in ${a.location || "an appropriate service"}.\n\n` +
      "Steps:\n1. studio_status: confirm the plugin is connected.\n2. studio_get_tree and studio_list_scripts: see what exists.\n" +
      "3. Build instances with studio_create_instance / studio_set_properties, or studio_execute_lua for anything bigger.\n" +
      "4. Write modern Luau (game:GetService, task.wait; never wait()/spawn()/delay()) with studio_create_script / studio_write_script.\n" +
      "5. studio_get_output: check for errors and fix them.",
  },
  {
    name: "roblox_debug_script",
    description: "Find and fix what is wrong with a Roblox script.",
    arguments: [
      { name: "script_path", description: 'Full path, e.g. "game.ServerScriptService.GameManager".', required: true },
      { name: "symptom", description: "What goes wrong (error text or behavior).", required: false },
    ],
    text: (a) =>
      `Debug the Roblox script at ${a.script_path ?? "(unspecified)"}.\n\n${a.symptom ? `Reported symptom: ${a.symptom}\n\n` : ""}` +
      "Steps:\n1. studio_read_script: read the source.\n2. studio_get_output: recent errors and warnings.\n" +
      "3. Find the root cause; do not patch symptoms.\n4. studio_edit_script or studio_write_script: apply the fix.\n5. studio_get_output: confirm the error is gone.",
  },
  {
    name: "roblox_review_script",
    description: "Review a Roblox script for bugs, performance and deprecated APIs.",
    arguments: [
      { name: "script_path", description: "Full path of the script.", required: true },
      { name: "focus", description: 'What to concentrate on, e.g. "performance".', required: false },
    ],
    text: (a) =>
      `Review the Roblox script at ${a.script_path ?? "(unspecified)"}. ` +
      `${a.focus ? `Focus on: ${a.focus}.` : "Cover bugs, performance, deprecated APIs and style."}\n\n` +
      "Read it with studio_read_script, then give a one-line summary, issues by severity, and concrete fixes.",
  },
  {
    name: "blender_build_scene",
    description: "Plan and build a Blender scene or model with bpy.",
    arguments: [{ name: "description", description: "What the scene or model should contain.", required: true }],
    text: (a) =>
      `Build this in Blender: ${a.description ?? "(unspecified)"}\n\n` +
      "Steps:\n1. blender_status: confirm the add-on is connected.\n2. blender_get_scene_info: see what exists.\n" +
      "3. blender_execute_python: build it with bpy.\n4. blender_get_object / blender_get_scene_info: check the result and fix what is off.",
  },
];

// ─────────────────────────────────────────────
// Resources
// ─────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

function readGuide() {
  for (const path of [join(HERE, "..", "skills.md"), join(HERE, "skills.md")]) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // try the next place
    }
  }
  return "Agent skill guide not found next to the server. See skills.md in https://github.com/iamjrmh/MCPBridge";
}

const RESOURCES = [
  { uri: "mcpbridge://guide", name: "MCPBridge agent skill guide", description: "How agents should drive MCPBridge: tools, workflows and rules.", mimeType: "text/markdown",
    read: async () => readGuide() },
  { uri: "mcpbridge://server/info", name: "MCPBridge server info", description: "Version, ports, default model and capability counts.", mimeType: "application/json",
    read: async () => pretty({
      name: "mcpbridge", version: VERSION, robloxPort: ROBLOX_PORT, blenderPort: BLENDER_PORT, ollamaBase: OLLAMA_BASE, defaultModel: DEFAULT_MODEL,
      tools: TOOLS.length, prompts: PROMPTS.length, resources: RESOURCES.length, studioMode: studio.mode, blenderMode: blender.mode,
    }) },
  { uri: "mcpbridge://studio/status", name: "Roblox Studio connection status", description: "Live connection state of the Roblox Studio plugin.", mimeType: "application/json",
    read: async () => pretty(await studio.status()) },
  { uri: "mcpbridge://studio/output", name: "Roblox Studio output log", description: "Recent Output lines captured from Roblox Studio.", mimeType: "text/plain",
    read: async () => (await studio.recentOutput(200)).join("\n") || "(no output captured yet)" },
  { uri: "mcpbridge://blender/status", name: "Blender connection status", description: "Live connection state of the Blender add-on.", mimeType: "application/json",
    read: async () => pretty(await blender.status()) },
  { uri: "mcpbridge://blender/output", name: "Blender output log", description: "Recent lines printed in Blender through MCPBridge.", mimeType: "text/plain",
    read: async () => (await blender.recentOutput(200)).join("\n") || "(no output captured yet)" },
];

// ─────────────────────────────────────────────
// MCP over stdio (JSON-RPC 2.0, one message per line)
// ─────────────────────────────────────────────

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "MCPBridge drives Roblox Studio (studio_* tools) and Blender (blender_* tools). Call studio_status or blender_status first. " +
  "studio_execute_lua and blender_execute_python can do anything the application's scripting API allows; the other tools are shortcuts. " +
  "If a tool says the plugin is not connected, tell the user the steps it lists.";

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function handleRequest(method, params = {}) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: "mcpbridge", title: "MCPBridge", version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call":
      return callTool(params.name, params.arguments);
    case "prompts/list":
      return { prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })) };
    case "prompts/get": {
      const prompt = PROMPTS.find((p) => p.name === params.name);
      if (!prompt) throw new RpcError(-32602, `Unknown prompt: ${params.name}`);
      return { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text(params.arguments ?? {}) } }] };
    }
    case "resources/list":
      return { resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })) };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read": {
      const resource = RESOURCES.find((r) => r.uri === params.uri);
      if (!resource) throw new RpcError(-32002, `Unknown resource: ${params.uri}`);
      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await resource.read() }] };
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function onMessage(message) {
  if (!message || typeof message !== "object") return;
  if (Array.isArray(message)) {
    await Promise.all(message.map(onMessage));
    return;
  }
  const isRequest = message.id !== undefined && message.id !== null && typeof message.method === "string";
  if (!isRequest) return;   // notifications and responses need no answer
  try {
    write({ jsonrpc: "2.0", id: message.id, result: await handleRequest(message.method, message.params) });
  } catch (error) {
    write({ jsonrpc: "2.0", id: message.id, error: { code: error instanceof RpcError ? error.code : -32603, message: String(error?.message ?? error) } });
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    onMessage(message).catch((error) => log(`request failed: ${error?.stack ?? error}`));
  }
});

// The agent closed: free the ports at once so the next session (or one that is
// relaying through this one) can take them.
let closing = false;
function shutdown(reason) {
  if (closing) return;
  closing = true;
  log(`shutting down (${reason})`);
  studio.stop();
  blender.stop();
  setTimeout(() => process.exit(0), 150);
}
process.stdin.on("end", () => shutdown("agent closed the connection"));
process.stdin.on("close", () => shutdown("agent closed the connection"));
process.stdout.on("error", () => shutdown("agent stopped reading"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => log(`unexpected error: ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => log(`unexpected rejection: ${error?.stack ?? error}`));

studio.start();
blender.start();
log(`MCPBridge ${VERSION} ready (${TOOLS.length} tools)`);
