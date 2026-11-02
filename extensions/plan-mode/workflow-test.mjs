import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const install = process.env.PI_TEST_INSTALL ?? join(homedir(), ".pi/agent/install/releases/1.4.0/node_modules");
const { createJiti } = await import(pathToFileURL(join(install, "jiti/lib/jiti.mjs")));
const tui = await import(pathToFileURL(join(install, "@earendil-works/pi-tui/dist/index.js")));
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-tui": join(install, "@earendil-works/pi-tui/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(install, "@earendil-works/pi-coding-agent/dist/index.js"),
		"typebox": join(install, "typebox/build/index.mjs"),
	},
	moduleCache: false,
});
const { default: extension } = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));
const theme = { fg: (_color, text) => text, strikethrough: (text) => text };
const keybindings = { matches: (data, action) => tui.matchesKey(data, { "tui.select.up": "up", "tui.select.down": "down", "tui.select.cancel": "escape" }[action]) };
const baseTools = ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "questionnaire", "codemode", "tool_search", "web_enable", "subagent", "reference_search", "external_mutation"];
const root = mkdtempSync(join(tmpdir(), "pi-plan-workflow-"));
const planPath = join(root, ".pi", "plan.md");
const planText = "# Agreed goal\nDeliver the requested feature.\n\n## Plan:\n1. Implement the agreed feature\n2. Verify the acceptance criteria\n\n## Verification\nRun the focused tests.\n";

function harness(entries = [], cwd = root) {
	const commands = new Map(), events = new Map(), tools = new Map(), widgets = new Map(), statuses = new Map();
	const notifications = [], sent = [], saved = [...entries];
	let active = [...baseTools], idle = true, aborted = 0, waits = 0, customCalls = 0;
	const api = {
		registerFlag() {}, registerShortcut() {},
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		on(name, fn) { const list = events.get(name) ?? []; list.push(fn); events.set(name, list); return () => {}; },
		getFlag: () => false,
		getActiveTools: () => active,
		getAllTools: () => [...new Set([...baseTools, ...tools.keys()])].map((name) => ({
			name,
			...(name === "reference_search" ? { annotations: { readOnlyHint: true, destructiveHint: false } } : {}),
			...(name === "external_mutation" ? { annotations: { destructiveHint: true } } : {}),
			...(tools.get(name) ?? {}),
		})),
		setActiveTools(names) { active = names; },
		appendEntry(customType, data) { saved.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage(message, options) { sent.push({ message, options }); },
		sendUserMessage(message, options) { sent.push({ message, options }); },
	};
	const ctx = {
		cwd, mode: "tui", hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort() { aborted++; idle = true; },
		async waitForIdle() { waits++; idle = true; },
		sessionManager: { getBranch: () => saved, getEntries: () => saved },
		ui: {
			theme,
			notify(...args) { notifications.push(args); },
			setStatus(name, text) { statuses.set(name, text); },
			setWidget(name, content) { widgets.set(name, content); },
			async select() { assert.fail("Workflow must not use automatic select dialogs"); },
			async custom(factory) {
				customCalls++;
				const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, keybindings, () => {});
				assert(component.render(80).length <= 19);
			},
		},
	};
	extension(api);
	return {
		ctx, commands, tools, widgets, statuses, notifications, sent, saved,
		get active() { return active; }, get aborted() { return aborted; }, get waits() { return waits; }, get customCalls() { return customCalls; },
		setIdle(value) { idle = value; },
		async emit(name, event = {}) { let result; for (const fn of events.get(name) ?? []) result = (await fn(event, ctx)) ?? result; return result; },
		async command(name, args = "") {
			const sentBefore = sent.length;
			await commands.get(name).handler(args, ctx);
			if (sent.length > sentBefore && sent.at(-1).options?.triggerTurn) {
				if (this.failStartup === "before") return;
				await this.emit("before_agent_start", {
					messageType: "custom", message: sent.at(-1).message,
					systemPromptOptions: { sections: {} },
				});
				if (this.failStartup !== "after") await this.emit("agent_start");
			}
		},
		async gate(toolName, input = {}) { return this.emit("tool_call", { toolName, input, toolCallId: "test-call" }); },
		async prompt(text = "Discuss this goal") {
			const event = { messageType: "user", prompt: text, systemPromptOptions: { sections: {}, guidelines: [] } };
			const result = await this.emit("before_agent_start", event);
			return JSON.stringify({ event, result });
		},
		async done(text) { return this.emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text }] } }); },
	};
}

try {
	const h = harness();
	await h.emit("session_start");
	assert(!existsSync(planPath), "startup must not create a plan");
	for (const [name, values] of [["plan", ["make", "execute", "steer", "status", "help"]], ["todos", ["all", "show", "hide", "help"]]]) {
		const choices = await h.commands.get(name).getArgumentCompletions("");
		for (const value of values) assert(choices.some((item) => item.value === value), `${name} completion: ${value}`);
	}
	await h.command("plan", "unexpected prompt");
	assert(h.active.includes("write"), "invalid arguments must not toggle state");
	await h.command("plan");
	assert((await h.gate("write", { path: join(root, "app.ts") }))?.block);
	assert((await h.gate("write", { path: planPath, content: planText }))?.block);
	assert((await h.gate("edit", { path: join(root, "app.ts") }))?.block);
	assert((await h.gate("subagent", { prompt: "modify files", tier: "low" }))?.block);
	assert.equal((await h.gate("questionnaire", { questions: [] }))?.block, undefined);
	assert.equal((await h.gate("reference_search", { query: "similar implementations" }))?.block, undefined);
	assert((await h.gate("external_mutation", {}))?.block);
	const discuss = await h.prompt();
	assert.match(discuss, /questionnaire/i);
	assert.match(discuss, /goal/i);
	assert.match(discuss, /explicitly confirm.*questionnaire/i);
	assert.match(discuss, /trade.?off/i);
	assert.match(discuss, /documentation|documents|docs/i);
	await h.prompt("Yes, execute it now.");
	assert((await h.gate("write", { path: planPath }))?.block, "chat yes cannot grant make or execute");
	await h.done("Plan:\n1. An informal discussion list is not a saved plan");
	await h.emit("agent_settled", { aborted: false });
	assert(!existsSync(planPath));
	await h.command("plan", "execute");
	assert((await h.gate("write", { path: join(root, "app.ts") }))?.block, "missing plan cannot execute");

	h.setIdle(false);
	await h.command("plan", "make");
	assert((await h.gate("write", { path: planPath }))?.block, "make must reject while busy");
	h.setIdle(true);
	await h.command("plan", "make");
	assert.equal((await h.gate("write", { path: planPath, content: planText }))?.block, undefined);
	assert((await h.gate("write", { path: join(root, "app.ts"), content: "bad" }))?.block);
	assert((await h.gate("edit", { path: join(root, ".pi", "..", "app.ts") }))?.block);
	assert((await h.gate("powershell", { command: "Set-Content app.ts bad" }))?.block);
	assert(h.sent.length > 0, "make must trigger a drafting run");
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(planPath, planText);
	await h.emit("agent_settled", { aborted: false });
	assert((await h.gate("write", { path: planPath }))?.block, "drafting grant ends at settlement");
	assert.match(h.notifications.map((item) => item[0]).join("\n"), /\/plan execute/);
	await h.command("todos", "show");
	assert.equal(typeof h.widgets.get("plan-todos"), "function");
	await h.command("todos", "all");
	assert.equal(h.customCalls, 1);
	const savedMode = h.ctx.mode;
	h.ctx.mode = "rpc";
	await h.command("todos", "all");
	assert.equal(h.customCalls, 1, "RPC must not open a terminal-only viewer");
	h.ctx.mode = savedMode;
	await h.command("todos", "hide");
	assert.equal(h.widgets.get("plan-todos"), undefined);

	await h.command("plan", "execute");
	assert.equal((await h.gate("write", { path: join(root, "app.ts") }))?.block, undefined);
	assert((await h.gate("write", { path: planPath }))?.block, "execution must not rewrite the approved plan");
	await h.done("Implemented and verified the first change. [DONE:1]");
	const beforeSteer = readFileSync(planPath, "utf8");
	h.setIdle(false);
	await h.command("plan", "steer");
	assert(h.aborted > 0, "steer aborts the active operation");
	assert(h.waits > 0, "steer waits for idle");
	assert.equal(readFileSync(planPath, "utf8"), beforeSteer);
	assert((await h.gate("write", { path: join(root, "app.ts") }))?.block);
	await h.command("todos", "show");
	let preview = h.widgets.get("plan-todos")({ terminal: { rows: 24 }, requestRender() {} }, theme).render(120).join("\n");
	assert.match(preview, /1\/2 completed/);

	await h.command("plan", "make");
	writeFileSync(planPath, planText.replace("Verify the acceptance criteria", "Verify the updated acceptance criteria"));
	await h.emit("agent_settled", { aborted: false });
	preview = h.widgets.get("plan-todos")({ terminal: { rows: 24 }, requestRender() {} }, theme).render(120).join("\n");
	assert.match(preview, /1\/2 completed/, "unchanged task retains completion");
	await h.command("plan", "make");
	const restoredMake = harness(h.saved);
	await restoredMake.emit("session_start");
	assert((await restoredMake.gate("write", { path: planPath }))?.block, "resume cannot renew a one-run make grant");
	await h.emit("agent_settled", { aborted: true });
	assert((await h.gate("write", { path: planPath }))?.block, "aborted make must return to discussion");
	await h.command("plan", "execute");
	const restored = harness(h.saved);
	await restored.emit("session_start");
	assert((await restored.gate("write", { path: join(root, "app.ts") }))?.block, "resume cannot silently renew execute authorization");
	assert.equal(restored.sent.length, 0);
	assert.equal(restored.widgets.get("plan-todos"), undefined, "preview stays hidden after reload");
	const anotherRoot = join(root, "another-project");
	mkdirSync(anotherRoot);
	const otherProject = harness(h.saved, anotherRoot);
	await otherProject.emit("session_start");
	await otherProject.command("plan", "execute");
	assert((await otherProject.gate("write", { path: join(anotherRoot, "app.ts") }))?.block,
		"a different project cannot execute a stale plan from the session");
	await h.done("Verified remaining work. [DONE:2]");
	await h.emit("agent_settled", { aborted: false });
	assert(existsSync(planPath));
	await h.command("todos", "show");
	assert.equal(typeof h.widgets.get("plan-todos"), "function", "completion must retain the task list");
	h.setIdle(false);
	const originalWait = h.ctx.waitForIdle;
	h.ctx.waitForIdle = async () => {
		assert((await h.gate("write", { path: join(root, "app.ts") }))?.block,
			"turning planning off must keep writes locked until the active operation stops");
		await originalWait();
	};
	await h.command("plan");
	assert(h.active.includes("write"), "off restores ordinary tools");
	assert.equal((await h.gate("write", { path: join(root, "app.ts") }))?.block, undefined);
	// Async preparation errors do not emit agent_settled in Pi. Both paths must revoke grants.
	for (const phase of ["before", "after"]) {
		for (const action of ["make", "execute"]) {
			const failed = harness();
			await failed.emit("session_start");
			failed.failStartup = phase;
			await failed.command("plan", action);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert((await failed.gate("write", { path: planPath }))?.block);
			assert((await failed.gate("write", { path: join(root, "app.ts") }))?.block);
			assert.match(failed.statuses.get("plan-mode"), /discuss/);
			await failed.emit("session_shutdown");
		}
	}
	const slowStart = harness();
	await slowStart.emit("session_start");
	slowStart.failStartup = "after";
	await slowStart.command("plan", "make");
	slowStart.setIdle(false);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.match(slowStart.statuses.get("plan-mode"), /make/, "busy preparation is not a startup failure");
	await slowStart.emit("agent_start");
	slowStart.setIdle(true);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.match(slowStart.statuses.get("plan-mode"), /make/, "agent_start cancels the startup watcher");
	await slowStart.emit("agent_settled", { aborted: true });
	assert.match(slowStart.statuses.get("plan-mode"), /discuss/);

	// Snapshot changes revoke execution before the next implementation tool call.
	const snapshot = harness();
	await snapshot.emit("session_start");
	await snapshot.command("plan", "execute");
	writeFileSync(planPath, planText + "\nExternal change.\n");
	assert((await snapshot.gate("write", { path: join(root, "app.ts") }))?.block);
	assert(snapshot.aborted > 0);
	await snapshot.emit("agent_settled", { aborted: true });
	assert((await snapshot.gate("write", { path: join(root, "app.ts") }))?.block);

	// Restore uses active ancestry, not unrelated abandoned entries returned by getEntries.
	const abandoned = structuredClone(h.saved.at(-1));
	abandoned.data.stage = "execute";
	abandoned.data.todos.forEach((item) => { item.completed = true; });
	const branch = harness();
	branch.ctx.sessionManager.getEntries = () => [abandoned];
	await branch.emit("session_start");
	await branch.command("todos", "show");
	const branchPreview = branch.widgets.get("plan-todos")({ terminal: { rows: 24 }, requestRender() {} }, theme).render(120).join("\n");
	assert.match(branchPreview, /0\/2 completed/);
	assert.equal((await branch.gate("write", { path: join(root, "app.ts") }))?.block, undefined,
		"abandoned branch state must not switch off-mode into planning");
	console.log("PASS: explicit workflow stages; questionnaire guidance; project plan; permission scope; busy guards; steer abort; progress reconciliation; resume and branches; async startup failure recovery; snapshot invalidation; command completions; todo viewer.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
