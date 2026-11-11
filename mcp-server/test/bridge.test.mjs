// Drives the real server over stdio with a stand-in for the Studio plugin.
// Run: node --test mcp-server/test
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const INDEX = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 47842;
const ports = () => ({ roblox: nextPort++, blender: nextPort++ });

/** One agent session: a server process plus a tiny JSON-RPC client. */
function session(p) {
  const child = spawn(process.execPath, [INDEX], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MCPBRIDGE_ROBLOX_PORT: String(p.roblox), MCPBRIDGE_BLENDER_PORT: String(p.blender) },
  });
  const waiting = new Map();
  let buffered = "";
  let id = 0;
  const self = { child, stderr: "", exited: false };
  child.stderr.on("data", (d) => (self.stderr += d));
  child.on("exit", () => (self.exited = true));
  child.stdout.on("data", (d) => {
    buffered += d;
    let at;
    while ((at = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  self.request = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  self.tool = async (name, args = {}) => {
    const answer = await self.request("tools/call", { name, arguments: args });
    return { text: answer.result.content[0].text, isError: !!answer.result.isError };
  };
  self.open = async () => {
    const hello = await self.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return hello.result;
  };
  self.close = async () => {
    child.stdin.end();
    for (let i = 0; i < 40 && !self.exited; i++) await sleep(50);
    const exitedByItself = self.exited;
    if (!self.exited) child.kill();
    return exitedByItself;
  };
  return self;
}

/** Stand-in for the Studio plugin: polls and answers every command, like OllamaMCP.lua. */
function plugin(port, answer = (command) => ({ result: { ok: true, values: ["ran " + command.type], output: ["hello from studio"] } })) {
  const self = { running: true, seen: [] };
  const base = "http://127.0.0.1:" + port;
  (async () => {
    while (self.running) {
      try {
        const polled = await fetch(base + "/poll?v=1.1.0").then((r) => r.json());
        if (polled.hasCommand) {
          self.seen.push(polled.command);
          await fetch(base + "/result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ commandId: polled.command.id, ...answer(polled.command) }),
          });
        }
      } catch {
        await sleep(100);
      }
    }
  })();
  self.stop = () => (self.running = false);
  return self;
}

test("speaks MCP: initialize, tools, prompts, resources", async () => {
  const a = session(ports());
  const hello = await a.open();
  assert.equal(hello.serverInfo.name, "mcpbridge");
  assert.equal(hello.protocolVersion, "2025-06-18");
  const tools = (await a.request("tools/list")).result.tools;
  assert.ok(tools.length >= 30, "only " + tools.length + " tools");
  for (const t of tools) assert.equal(t.inputSchema.type, "object", t.name);
  for (const name of ["studio_execute_lua", "studio_set_properties", "studio_create_instance", "studio_get_tree", "blender_execute_python", "blender_get_object"]) {
    assert.ok(tools.some((t) => t.name === name), name);
  }
  assert.equal((await a.request("prompts/list")).result.prompts.length, 4);
  const prompt = await a.request("prompts/get", { name: "roblox_build_feature", arguments: { feature: "a door" } });
  assert.match(prompt.result.messages[0].content.text, /a door/);
  const info = await a.request("resources/read", { uri: "mcpbridge://server/info" });
  assert.equal(JSON.parse(info.result.contents[0].text).tools, tools.length);
  assert.equal((await a.request("nope/nothing")).error.code, -32601);
  assert.deepEqual((await a.request("ping")).result, {});
  await a.close();
});

test("without a plugin a tool fails quickly and says how to connect", async () => {
  const a = session(ports());
  await a.open();
  const started = Date.now();
  const out = await a.tool("studio_execute_lua", { code: "return 1" });
  assert.ok(out.isError);
  assert.match(out.text, /not connected/);
  assert.match(out.text, /MCP Bridge/);
  assert.ok(Date.now() - started < 9000, "took too long to say so");
  assert.match((await a.tool("studio_status")).text, /NOT connected/);
  await a.close();
});

test("a command reaches the plugin and its result, output and errors come back", async () => {
  const p = ports();
  const a = session(p);
  await a.open();
  const studio = plugin(p.roblox, (command) =>
    command.payload.code === "boom"
      ? { result: { ok: false, error: "MCPBridge:1: attempt to call a nil value", output: ["before the error"] } }
      : command.type === "set_properties"
        ? { error: 'Part has no property "Colour"' }
        : { result: { ok: true, values: [42], output: ["hello from studio"] } }
  );
  await sleep(300);
  assert.match((await a.tool("studio_status")).text, /is CONNECTED/);
  const started = Date.now();
  const ran = await a.tool("studio_execute_lua", { code: "return 42" });
  assert.ok(Date.now() - started < 1000, "a held poll should deliver at once");
  assert.equal(ran.isError, false);
  assert.match(ran.text, /Result: 42/);
  assert.match(ran.text, /hello from studio/);
  const failed = await a.tool("studio_execute_lua", { code: "boom" });
  assert.ok(failed.isError);
  assert.match(failed.text, /attempt to call a nil value/);
  assert.match(failed.text, /before the error/);
  const refused = await a.tool("studio_set_properties", { path: "game.Workspace.Part", properties: { Colour: 1 } });
  assert.ok(refused.isError);
  assert.match(refused.text, /no property "Colour"/);
  assert.deepEqual(studio.seen.at(-1).payload.properties, { Colour: 1 });
  studio.stop();
  await a.close();
});

test("a server exits when its agent closes, freeing the port", async () => {
  const p = ports();
  const a = session(p);
  await a.open();
  assert.equal(await a.close(), true, "server kept running after its agent closed");
  await assert.rejects(fetch("http://127.0.0.1:" + p.roblox + "/health"));
});

test("a second session works through the first, and takes over when the first closes", async () => {
  const p = ports();
  const first = session(p);
  await first.open();
  const studio = plugin(p.roblox);
  await sleep(300);
  const second = session(p);
  await second.open();
  await sleep(600);
  assert.match((await second.tool("studio_status")).text, /is CONNECTED[\s\S]*shared with another open session/);
  assert.match((await second.tool("studio_execute_lua", { code: "return 1" })).text, /ran execute/);
  assert.match((await first.tool("studio_execute_lua", { code: "return 1" })).text, /ran execute/);

  await first.close();
  let after;
  for (let i = 0; i < 40; i++) {
    after = await second.tool("studio_execute_lua", { code: "return 2" });
    if (!after.isError) break;
    await sleep(500);
  }
  assert.equal(after.isError, false, after.text);
  assert.doesNotMatch((await second.tool("studio_status")).text, /shared with another/);
  studio.stop();
  await second.close();
});

test("a port held by something that is not MCPBridge is reported plainly", async () => {
  const p = ports();
  const squatter = http.createServer((_req, res) => res.end("hi")).listen(p.roblox, "127.0.0.1");
  await sleep(100);
  const a = session(p);
  await a.open();
  await sleep(500);
  const out = await a.tool("studio_execute_lua", { code: "return 1" });
  assert.ok(out.isError);
  assert.match(out.text, /in use by another program/);
  squatter.close();
  await a.close();
});
