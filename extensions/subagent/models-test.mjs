import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const install = process.env.PI_TEST_INSTALL ?? join(homedir(), ".pi/agent/install/releases/1.5.0/node_modules");
const { getSupportedThinkingLevels } = await import(pathToFileURL(`${install}/@earendil-works/pi-ai/dist/models.js`));
const tui = await import(pathToFileURL(`${install}/@earendil-works/pi-tui/dist/index.js`));
function compile(file, exports, dependencies) {
 const source = stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
 return new Function(...Object.keys(dependencies), `${source}\nreturn {${exports}};`)(...Object.values(dependencies));
}
const { createModelPicker, INHERIT } = compile("./model-picker.ts", "createModelPicker, INHERIT", tui);
const parent = { provider: "a", id: "simple", name: "Quick Chat", reasoning: false };
const reasoning = { provider: "b", id: "org/reasoner", name: "Deep Reasoning", reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "extra", max: null } };
const theme = { fg: (_c, s) => s };
const keys = tui.getKeybindings();
function picker(query, key = "\r") {
 let result = null;
 const component = createModelPicker([parent, reasoning], undefined, "Test models", { requestRender() {} }, theme, keys, v => { result = v; });
 component.focused = true;
 assert.equal(component.focused, true);
 for (const ch of query) component.handleInput(ch);
 for (const width of [8, 20, 80]) assert(component.render(width).every(line => tui.visibleWidth(line) <= width));
 component.handleInput(key);
 return result;
}
assert.equal(picker("b/org/reasoner"), "b/org/reasoner");
assert.equal(picker("Deep Reasoning"), "b/org/reasoner");
assert.equal(picker("quick"), "a/simple");
assert.equal(picker("clear tier"), INHERIT);
assert.equal(picker("zzzzzzzz"), null, "no match must not select");
assert.equal(picker("simple", "\x1b"), undefined);
assert.equal(picker("", "\x1b[B"), null); // navigation doesn't confirm

const disk = new Map();
const file = join("test-agent", "subagent-models.json");
let picked, selections = 0;
const dependencies = {
 mkdirSync() {},
 readFileSync(path) { if (!disk.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return disk.get(path); },
 renameSync(from, to) { disk.set(to, disk.get(from)); disk.delete(from); },
 rmSync(path) { disk.delete(path); }, writeFileSync(path, value) { disk.set(path, value); },
 dirname, join, randomUUID: () => "test", getSupportedThinkingLevels, INHERIT,
 selectTierModel: async () => { selections++; return picked; },
 getAgentDir: () => "test-agent", withFileMutationQueue: async (_path, fn) => fn(),
};
const { registerSubagentModels } = compile("./models.ts", "registerSubagentModels", dependencies);
let command;
let thinkingLevel = "off";
const api = registerSubagentModels({ getThinkingLevel: () => thinkingLevel, registerCommand(name, spec) { assert.equal(name, "subagent-model"); command = spec; } });
let available = [parent, reasoning];
const notifications = [];
let choices = [];
const ctx = { model: parent, modelRegistry: { getAvailable: () => available }, mode: "tui", hasUI: true,
 ui: { select: async (_title, options) => { const choice = choices.shift(); return typeof choice === "number" ? options[choice] : choice; }, notify: (...args) => notifications.push(args) } };
for (const tier of ["low", "medium", "high", "max"]) {
 assert.deepEqual(api.resolve(ctx, tier), { model: "a/simple", thinkingLevel: "off" });
 assert.match(api.describe(ctx), new RegExp(`${tier}: current parent model a/simple`));
}
assert.match(api.describe(ctx), /^Current session \(you\):\nmodel: a\/simple\nthinking: off\nThese are your settings, not the subagent tier defaults\./);
thinkingLevel = "medium";
assert.match(api.describe({ ...ctx, model: reasoning }), /^Current session \(you\):\nmodel: b\/org\/reasoner\nthinking: medium\n/);
assert.match(api.describe({ ...ctx, model: undefined }), /model: unknown\nthinking: medium/);
thinkingLevel = "off";
assert.throws(() => api.resolve(ctx, "bogus"), /Unknown subagent tier/);
assert.throws(() => api.resolve(ctx, undefined), /Unknown subagent tier/);
assert.throws(() => api.resolve(ctx, "low", "high"), /Unsupported thinking/);
picked = "b/org/reasoner"; choices = [2, "Done"];
await command.handler("", ctx);
assert.equal(selections, 1);
assert.deepEqual(JSON.parse(disk.get(file)), { high: "b/org/reasoner" });
assert.equal(api.resolve(ctx, "high").model, "b/org/reasoner");
assert.equal(api.resolve(ctx, "high").thinkingLevel, "low");
assert.equal(api.resolve(ctx, "high", "xhigh").thinkingLevel, "xhigh");
assert.throws(() => api.resolve(ctx, "high", "max"), /Unsupported thinking/);
assert.match(api.describe(ctx), /thinking: low, medium, high, xhigh/);
assert(!api.describe(ctx).includes("explicit model overrides"));
available = [parent];
assert.throws(() => api.resolve(ctx, "high"), /not available/);
assert.match(api.describe(ctx), /high: b\/org\/reasoner.*unavailable/);
picked = undefined; choices = [2, "Done"];
await command.handler("", ctx);
assert.equal(JSON.parse(disk.get(file)).high, "b/org/reasoner", "cancel preserves mapping");
picked = INHERIT; choices = [2, "Done"];
await command.handler("", ctx);
assert.deepEqual(JSON.parse(disk.get(file)), {});
await command.handler("", { ...ctx, mode: "rpc" });
assert.match(notifications.at(-1)[0], /TUI mode/);
assert.throws(() => api.resolve({ ...ctx, model: undefined }, "low"), /No current parent model/);
disk.set(file, "{broken");
assert.throws(() => api.resolve(ctx, "low"), /Invalid/);
assert.match(api.describe(ctx), /configuration error/);
assert.match(api.describe(ctx), /^Current session \(you\):\nmodel: a\/simple\nthinking: off\n/);
assert.equal(ctx.model, parent);
console.log("PASS: tier-only resolution; supported thinking; searchable picker by provider/id/name; clear/cancel/no-match/narrow widths; configuration persistence; parent unchanged.");
