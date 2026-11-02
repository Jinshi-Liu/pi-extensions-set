// Regression checks without model calls; --live adds two real child calls.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// Official getPiInvocation relaunches this file: emulate the JSON CLI.
if (process.argv.includes("--mode")) {
  const args = process.argv.slice(2);
  assert.equal(process.env.PI_SUBAGENT_CHILD, "1");
  const excludes = args[args.indexOf("--exclude-tools") + 1].split(",");
  assert(excludes.includes("subagent"));
  const tools = args.includes("--tools") ? args[args.indexOf("--tools") + 1].split(",") : [];
  assert(!tools.includes("subagent"));
  assert.equal(excludes.includes("mcp__*"), !tools.some((n) => n.startsWith("mcp__")));
  assert.equal(args.includes("--no-tools"), tools.length === 0);
  assert(!args.includes("--no-extensions"));
  assert(!args.includes("--no-skills"));
  const promptFile = args[args.indexOf("--append-system-prompt") + 1];
  assert.match(fs.readFileSync(promptFile, "utf8"), /Never call subagent/);
  const task = args.at(-1);
  if (task.includes("SIMULATE_FAILURE")) {
    process.stderr.write("simulated child failure");
    process.exit(2);
  }
  if (task.includes("SIMULATE_PROGRESS")) {
    console.log(JSON.stringify({ type: "message_end", message: {
      role: "assistant", content: [{ type: "toolCall", id: "read-test", name: "read", arguments: { path: "README.md" } }], stopReason: "toolUse",
    } }));
  }
  await new Promise((resolve) => setTimeout(resolve, task.includes("SIMULATE_LONG_TASK") ? 30_000 : 50));
  console.log(JSON.stringify({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: JSON.stringify({ args, task, cwd: process.cwd(), promptFile }) }],
    stopReason: "stop", usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
  } }));
  process.exit(0);
}


const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = path.join(os.homedir(), ".pi", "agent");
const install = process.env.PI_MANAGED_INSTALL_ROOT || path.join(agentDir, "install");
const modules = process.env.PI_TEST_INSTALL ?? path.join(install, "releases", fs.readFileSync(path.join(install, "current-version"), "utf8").trim(), "node_modules");
const pkgDir = path.join(modules, "@earendil-works/pi-coding-agent");
const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(path.join(pkgDir, "dist/core/extensions/loader.js")));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-background-"));
process.env.PI_CODING_AGENT_DIR = scratch;
const runtime = createExtensionRuntime();
runtime.getActiveTools = () => ["read", "write", "subagent"];
runtime.getThinkingLevel = () => "low";
const sent = [];
runtime.sendMessage = (...args) => sent.push(args);
async function load() {
 const loaded = await loadExtensions([path.join(dir, "index.ts")], dir, undefined, runtime);
 assert.deepEqual(loaded.errors, []);
 return loaded.extensions[0];
}
let ext = await load();
let panel, panelFactory;
const ui = { notify() {}, theme: { fg: (_c, v) => v }, setWidget(_key, value) {
 panelFactory = typeof value === "function" ? value : undefined;
 panel = panelFactory?.({}, ui.theme).render(100);
}};
let idle = false;
const model = { provider: "test", id: "parent", reasoning: true };
const ctx = { cwd: scratch, model, modelRegistry: { getAvailable: () => [model] },
 sessionManager: { getSessionId: () => "parent-test" }, thinkingLevel: "low",
 isIdle: () => idle, hasUI: true, ui };
let tool = ext.tools.get("subagent").definition;
const run = (params) => tool.execute("test", { tier: "high", ...params }, undefined, undefined, ctx);
const status = async (session) => JSON.parse((await run({ action: "status", session })).content[0].text);
const handlers = async (event, data = {}) => {
 const out = []; for (const fn of ext.handlers.get(event) ?? []) out.push(await fn(data, ctx)); return out;
};
const wait = async (session) => {
 for (let i = 0; i < 300; i++) {
  const child = (await status(session))[0];
  if (child.state !== "running") return child;
  await new Promise(r => setTimeout(r, 20));
 }
 throw new Error("Timeout " + session);
};
const boundary = () => handlers("turn_end", { entries: [{ type: "custom", customType: "other" }], outcome: "completed", context: { canContinue: true } });
try {
 assert.deepEqual([...ext.commands.keys()].sort(), ["subagent", "subagent-model"]);
 assert(!("model" in tool.parameters.properties));
 assert(!("role" in tool.parameters.properties));
 await assert.rejects(tool.execute("missing", { prompt: "missing tier" }, undefined, undefined, ctx), /tier is required/);
 await handlers("session_start");
 await ext.commands.get("subagent").handler("", ctx);
 assert(panel);
 await ext.commands.get("subagent").handler("", ctx);
 assert.equal(panel, undefined);
 await ext.commands.get("subagent").handler("", ctx);
 const ack = JSON.parse((await run({ prompt: "SIMULATE_PROGRESS", session: "researcher", tier: "high", thinking: "low" })).content[0].text);
 assert.equal(ack.status, "running");
 assert.equal((await status("researcher"))[0].state, "running");
 await assert.rejects(run({ prompt: "race", session: "researcher" }), /busy/);
 const first = await wait("researcher");
 assert.equal(first.state, "completed");
 assert.equal(sent.length, 0, "busy parent must not receive callback injection");
 const data = JSON.parse(first.result);
 assert(data.args.includes("--session-id"));
 assert(!data.args.includes("--no-session"));
 assert.equal(data.args[data.args.indexOf("--thinking") + 1], "low");
 assert.equal(data.args[data.args.indexOf("--tools") + 1], "read,write");
 assert(!fs.existsSync(data.promptFile));
 const delivered = (await boundary()).find(Boolean);
 assert.equal(delivered.entries.length, 2, "preserve earlier boundary entries");
 assert.equal(delivered.continue, true);
 assert.match(delivered.entries[1].content, /researcher: completed/);
 assert(!(await boundary()).find(Boolean), "deliver once");
 await run({ prompt: "follow-up", session: "researcher", tier: undefined });
 const second = await wait("researcher");
 assert.equal(second.childId, first.childId);
 assert.equal(second.tier, "high");
 assert.equal(second.thinkingLevel, "off");
 assert.deepEqual(second.tools, ["read", "write"]);
 await boundary();
 await run({ prompt: "SIMULATE_FAILURE", session: "failure" });
 assert.equal((await wait("failure")).state, "failed");
 await boundary();
 idle = true;
 await run({ prompt: "idle task", session: "idle" });
 await wait("idle");
 assert.equal(sent.length, 1);
 assert.equal(sent[0][1].deliverAs, "followUp");
 assert.equal(sent[0][1].triggerTurn, true);
 idle = false;
 const parentAbort = new AbortController();
 await tool.execute("test", { prompt: "SIMULATE_LONG_TASK", session: "cancel", tier: "low" }, parentAbort.signal, undefined, ctx);
 parentAbort.abort();
 assert.equal((await status("cancel"))[0].state, "running", "background lifetime not tied to dispatch signal");
 await run({ action: "cancel", session: "cancel" });
 assert.equal((await wait("cancel")).state, "cancelled");
 await boundary();
 await assert.rejects(run({ prompt: " " }), /blank/);
 await assert.rejects(run({ prompt: "bad", thinking: "bogus" }), /Supported:/);
 await Promise.all([run({ prompt: "A", session: "a" }), run({ prompt: "B", session: "b" })]);
 await Promise.all([wait("a"), wait("b")]);
 const both = (await boundary()).find(Boolean);
 assert.match(both.entries[1].content, /Subagent a/);
 assert.match(both.entries[1].content, /Subagent b/);
 const { visibleWidth } = await import(pathToFileURL(path.resolve(pkgDir, "../pi-tui/dist/index.js")));
 for (const width of [1, 8, 16, 28, 60, 100]) assert(panelFactory({}, ui.theme).render(width).every(l => visibleWidth(l) <= width));
 await run({ prompt: "SIMULATE_LONG_TASK", session: "shutdown" });
 await handlers("session_shutdown");
 ext = await load(); tool = ext.tools.get("subagent").definition;
 await handlers("session_start");
 const restored = (await status("researcher"))[0];
 assert.equal(restored.childId, first.childId);
 assert.equal(restored.tier, first.tier);
 const recovered = (await handlers("before_agent_start")).filter(Boolean);
 assert(recovered.some(r => /shutdown: cancelled/.test(r.message.content)));
 assert(recovered.some(r => /thinking:/.test(r.message.content)));
 await run({ prompt: "resume after reload", session: "researcher" });
 assert.equal((await wait("researcher")).childId, first.childId);
 await boundary();
 console.log("PASS: background ack; safe boundaries; idle notification; persistent tier/session/config; busy rejection; parallel work; cancellation/shutdown/reload; model validation; status toggle and narrow widths.");
} finally {
 await handlers("session_shutdown");
 fs.rmSync(scratch, { recursive: true, force: true });
}
