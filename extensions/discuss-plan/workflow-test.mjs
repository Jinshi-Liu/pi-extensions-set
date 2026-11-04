import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const install = process.env.PI_TEST_INSTALL ?? join(homedir(), ".pi/agent/install/releases/1.5.0/node_modules");
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
const { parsePlanArgs, planPath: getPlanPath } = await jiti.import(fileURLToPath(new URL("./workflow.ts", import.meta.url)));
const theme = { fg: (_color, text) => text, strikethrough: (text) => text };
const keybindings = { matches: (data, action) => tui.matchesKey(data, { "tui.select.up": "up", "tui.select.down": "down", "tui.select.cancel": "escape" }[action]) };
const baseTools = ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "questionnaire", "codemode", "tool_search", "web_enable", "subagent", "reference_search", "external_mutation"];
const root = mkdtempSync(join(tmpdir(), "pi-plan-workflow-"));
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const planPath = getPlanPath(root, SESSION_A);
const planText = "# Agreed goal\nDeliver the requested feature.\n\n## Plan:\n1. Implement the agreed feature\n2. Verify the acceptance criteria\n\n## Verification\nRun the focused tests.\n";

function harness(entries = [], cwd = root, sessionId = SESSION_A) {
	const commands = new Map(), events = new Map(), tools = new Map(), widgets = new Map(), statuses = new Map();
	const notifications = [], sent = [], saved = [...entries], selections = [], confirmations = [];
	const shortcuts = [], flags = new Map();
	let sessionName = "Shared display name";
	const dialogs = { choose: undefined, confirm: false, beforeSelect: undefined, beforeConfirm: undefined };
	let pending = false;
	let active = [...baseTools], idle = true, aborted = 0, waits = 0, customCalls = 0;
	const api = {
		registerFlag(name, options) { flags.set(name, options.default); },
		registerShortcut(key, options) { shortcuts.push({ key, ...options }); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		on(name, fn) { const list = events.get(name) ?? []; list.push(fn); events.set(name, list); return () => {}; },
		getFlag: name => flags.get(name),
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
		hasPendingMessages: () => pending,
		abort() { aborted++; idle = true; },
		async waitForIdle() { waits++; idle = true; },
		sessionManager: {
			getBranch: () => saved, getEntries: () => saved,
			getSessionId: () => sessionId, getSessionName: () => sessionName,
		},
		ui: {
			theme,
			notify(...args) { notifications.push(args); },
			setStatus(name, text) { statuses.set(name, text); },
			setWidget(name, content) { widgets.set(name, content); },
			async select(title, options) {
				selections.push({ title, options });
				await dialogs.beforeSelect?.();
				return typeof dialogs.choose === "function" ? dialogs.choose(options) : dialogs.choose;
			},
			async confirm(title, message) {
				confirmations.push({ title, message });
				await dialogs.beforeConfirm?.();
				return dialogs.confirm;
			},
			async custom(factory) {
				customCalls++;
				const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, keybindings, () => {});
				assert(component.render(80).length <= 19);
			},
		},
	};
	extension(api);
	return {
		ctx, commands, tools, widgets, statuses, notifications, sent, saved, selections, confirmations, dialogs, shortcuts, flags,
		setSessionName(name) { sessionName = name; },
		get active() { return active; }, get aborted() { return aborted; }, get waits() { return waits; }, get customCalls() { return customCalls; },
		setIdle(value) { idle = value; },
		setPending(value) { pending = value; },
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

const stage = (h) => h.saved.at(-1)?.data.stage;
const latest = (h) => h.saved.at(-1)?.data;
const appPath = join(root, "app.ts");
const blocked = async (h, path = appPath) => assert((await h.gate("write", { path }))?.block);
const allowed = async (h, path = appPath) => assert.equal((await h.gate("write", { path }))?.block, undefined);
const preview = (h) => h.widgets.get("plan-todos")?.({ terminal: { rows: 24 }, requestRender() {} }, theme).render(120).join("\n");
const all = [];
async function fresh(entries = [], cwd = root, id = SESSION_A) {
	const h = harness(entries, cwd, id); all.push(h); await h.emit("session_start"); return h;
}
function save(text = planText, path = planPath) {
	mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text);
}
try {
	for (const command of ["plan", "discuss"]) {
		assert.deepEqual(parsePlanArgs("", command), { action: "prompt", prompt: "" });
		assert.deepEqual(parsePlanArgs("-- off 中文\nKeep API_Name", command), { action: "prompt", prompt: "off 中文\nKeep API_Name" });
		assert.deepEqual(parsePlanArgs("OFF", command), { action: "off", prompt: "" });
		for (const old of ["make", "execute", "steer", "status"]) assert.deepEqual(parsePlanArgs(old, command), { action: "prompt", prompt: old });
	}
	assert.deepEqual(parsePlanArgs("CLONE"), { action: "clone", prompt: "" });
	assert.deepEqual(parsePlanArgs("clear", "discuss"), { action: "prompt", prompt: "clear" });
	const h = await fresh();
	assert(!existsSync(planPath)); assert.equal(h.notifications.length, 0);
	assert.deepEqual([...h.commands.keys()].sort(), ["discuss", "implement", "plan", "todos"]);
	for (const [name, choices] of [["plan", ["clone", "clear", "help", "off"]], ["discuss", ["help", "off"]], ["todos", ["all", "show", "hide", "help"]]]) {
		assert.deepEqual(h.commands.get(name).getArgumentCompletions("").map(x => x.value), choices);
		assert.equal(h.commands.get(name).getArgumentCompletions("off extra"), null);
	}
	const statusColors = [];
	h.ctx.ui.theme = { ...theme, fg: (color, text) => { statusColors.push(color); return text; } };
	await h.command("discuss");
	assert.equal(h.statuses.get("discuss-plan"), "discuss", "footer omits the extension prefix");
	assert.equal(statusColors.at(-1), "mdLink", "footer uses the theme's blue link color");
	await blocked(h); await blocked(h, planPath);
	const count = h.sent.length;
	await h.command("discuss"); assert.equal(h.sent.length, count); assert.equal(stage(h), "discuss");
	await h.command("discuss", "讨论登录功能");
	assert.equal(h.sent.at(-1).message, "讨论登录功能");
	const guidance = await h.prompt("yes implement now");
	for (const pattern of [/questionnaire/, /All generated questionnaire content/, /must follow the user's language/, /do not impose English/, /explicitly confirm.*questionnaire/]) assert.match(guidance, pattern);
	await blocked(h, planPath);
	for (const name of ["subagent", "external_mutation", "powershell"]) assert((await h.gate(name, {}))?.block);
	for (const name of ["questionnaire", "reference_search", "codemode", "web_enable"]) assert.equal((await h.gate(name))?.block, undefined);
	assert((await h.gate("bash", { command: "git status; rm app.ts" }))?.block);
	assert.equal((await h.gate("bash", { command: "git status" }))?.block, undefined);
	assert((await h.gate("grep", { path: root, pattern: "." }))?.block);

	await h.command("plan", "保留 API_Name\n增加测试");
	assert.equal(stage(h), "plan"); assert.match(h.sent.at(-1).message.content, /保留 API_Name\n增加测试$/);
	await allowed(h, planPath); await blocked(h);
	save();
	for (const aborted of [false, true]) {
		await h.emit("agent_settled", { aborted }); await h.prompt("继续修改");
		assert.equal(stage(h), "plan"); await allowed(h, planPath); await blocked(h);
	}
	await h.command("todos", "show"); assert.match(preview(h), /0\/2 completed/);
	await h.command("todos", "all"); assert.equal(h.customCalls, 1);
	h.ctx.mode = "rpc"; await h.command("todos", "all"); assert.equal(h.customCalls, 1); h.ctx.mode = "tui";
	await h.command("todos", "hide"); assert.equal(h.widgets.get("plan-todos"), undefined);

	await h.command("implement", "先测试");
	assert.equal(stage(h), "execute"); assert.match(h.sent.at(-1).message.content, /先测试$/);
	assert.equal(h.statuses.get("discuss-plan"), "implement 0/2", "execution footer matches /implement without changing the internal stage");
	assert.equal(statusColors.at(-1), "mdLink");
	await allowed(h); await blocked(h, planPath);
	const executionCount = h.sent.length;
	await h.command("implement"); assert.equal(h.sent.length, executionCount);
	await h.done("[DONE:1]");
	h.setIdle(false);
	const oldWait = h.ctx.waitForIdle;
	h.ctx.waitForIdle = async () => { await blocked(h); await blocked(h, planPath); await oldWait(); };
	await h.command("plan", "修订第二步");
	assert.equal(stage(h), "plan"); assert(h.aborted && h.waits); await allowed(h, planPath); await blocked(h);
	assert.equal(readFileSync(planPath, "utf8"), planText);
	save(planText.replace("Verify the acceptance criteria", "Verify updated acceptance criteria"));
	await h.emit("agent_settled");
	await h.command("todos", "show"); assert.match(preview(h), /1\/2 completed/);
	h.ctx.waitForIdle = oldWait;
	await h.command("discuss");
	const beforeDirect = readFileSync(planPath, "utf8");
	await h.command("implement");
	assert.equal(stage(h), "off"); assert.equal(h.sent.at(-1).message, "Implement the plan we just discussed.");
	await allowed(h); assert.equal((await h.gate("subagent"))?.block, undefined);
	assert.equal(readFileSync(planPath, "utf8"), beforeDirect);
	assert.equal((await h.emit("context", { messages: h.sent.filter(x => typeof x.message === "object").map(x => x.message) })).messages.length, 0, "stale author/execute messages must be removed in ordinary execution");
	await h.command("implement", "实现明确任务");
	assert.match(h.sent.at(-1).message, /ask for clarification/); assert.match(h.sent.at(-1).message, /实现明确任务$/);
	for (const command of ["plan", "discuss"]) {
		await h.command("plan");
		const before = h.sent.length; h.setIdle(false);
		await h.command(command, "off"); assert.equal(stage(h), "off"); assert.equal(h.sent.length, before);
		await allowed(h); assert(existsSync(planPath)); assert(latest(h).todos[0].completed);
	}
	// Removed keywords are prompt text, not aliases; reserved argument errors do nothing.
	for (const word of ["make", "execute", "steer", "status"]) {
		await h.command("plan", word); assert.equal(stage(h), "plan"); assert.match(h.sent.at(-1).message.content, new RegExp(word + "$"));
	}
	const stateBefore = h.saved.length;
	await h.command("plan", "clear unexpected"); assert.equal(h.saved.length, stateBefore);
	await h.command("plan", "-- clear this requirement"); assert.match(h.sent.at(-1).message.content, /clear this requirement$/);
	await h.command("discuss", "-- off topic"); assert.equal(h.sent.at(-1).message, "off topic");

	// Durable intent, ownership and branch isolation.
	await h.command("plan");
	const restoredPlan = await fresh(h.saved);
	assert.equal(restoredPlan.sent.length, 0); await allowed(restoredPlan, planPath); await blocked(restoredPlan);
	await h.command("implement");
	const restoredExecution = await fresh(h.saved);
	await allowed(restoredExecution, planPath); await blocked(restoredExecution); assert.equal(restoredExecution.sent.length, 0);
	assert.equal(restoredExecution.widgets.get("plan-todos"), undefined);
	for (const oldStage of ["off", "discuss", "make", "execute"]) {
		const data = { ...latest(h), version: 1, stage: oldStage };
		const migrated = await fresh([{ type: "custom", customType: "plan-workflow", data }]);
		const prompt = await migrated.prompt();
		assert.equal(migrated.sent.length, 0);
		if (["make", "execute"].includes(oldStage)) { assert.match(prompt, /Stage: PLAN/); await allowed(migrated, planPath); await blocked(migrated); }
		else if (oldStage === "discuss") { await blocked(migrated, planPath); assert.match(prompt, /Stage: DISCUSS/); }
		else await allowed(migrated);
	}
	const isolated = await fresh(h.saved, root, SESSION_B);
	await isolated.command("todos", "show"); assert.equal(preview(isolated), undefined);
	await isolated.command("plan"); const otherPath = getPlanPath(root, SESSION_B);
	await allowed(isolated, otherPath); await blocked(isolated, planPath);
	assert((await isolated.gate("read", { path: planPath }))?.block);
	const beforeMissing = isolated.sent.length; await isolated.command("implement"); assert.equal(isolated.sent.length, beforeMissing); assert.equal(stage(isolated), "plan");
	for (const invalid of ["", "No task list", "## Plan:\n"]) {
		save(invalid, otherPath); await isolated.command("implement"); assert.equal(stage(isolated), "plan"); assert.equal(isolated.sent.length, beforeMissing);
	}
	const otherRoot = join(root, "other"); mkdirSync(otherRoot);
	const differentProject = await fresh(h.saved, otherRoot);
	await differentProject.command("todos", "show"); assert.equal(preview(differentProject), undefined);
	const branch = await fresh();
	branch.ctx.sessionManager.getEntries = () => h.saved;
	await branch.emit("session_tree"); await allowed(branch);
	await branch.command("todos", "show"); assert.match(preview(branch), /0\/2 completed/);
	h.setSessionName("New display name"); await h.command("todos", "show"); assert.match(preview(h), /1\/2 completed/);

	// Clone cancellation, success, overwrite/reset, and stale dialog.
	const cloner = await fresh([], root, SESSION_B);
	const originalOther = readFileSync(otherPath, "utf8");
	await cloner.command("plan", "clone"); assert.equal(readFileSync(otherPath, "utf8"), originalOther); assert.equal(cloner.sent.length, 0);
	cloner.dialogs.choose = options => options.find(x => x.includes(SESSION_A));
	cloner.dialogs.confirm = false;
	await cloner.command("plan", "clone"); assert.equal(readFileSync(otherPath, "utf8"), originalOther);
	cloner.dialogs.confirm = true;
	await cloner.command("plan", "clone"); assert.equal(stage(cloner), "plan"); assert.equal(cloner.sent.length, 0);
	assert.equal(readFileSync(otherPath, "utf8"), readFileSync(planPath, "utf8"));
	await allowed(cloner, otherPath); await cloner.command("implement"); await cloner.done("[DONE:1]");
	await cloner.command("discuss"); await cloner.command("todos", "show"); assert.match(preview(cloner), /1\/2 completed/);
	cloner.dialogs.confirm = false; await cloner.command("plan", "clone"); assert.equal(stage(cloner), "discuss"); assert.match(preview(cloner), /1\/2 completed/);
	cloner.dialogs.confirm = true; await cloner.command("plan", "clone"); await cloner.command("todos", "show"); assert.match(preview(cloner), /0\/2 completed/);
	const cloneResume = await fresh(cloner.saved, root, SESSION_B);
	await cloneResume.command("todos", "show"); assert.match(preview(cloneResume), /0\/2 completed/);
	cloner.setIdle(false); const selections = cloner.selections.length;
	await cloner.command("plan", "clone"); assert.equal(cloner.selections.length, selections); cloner.setIdle(true);
	const freshId = "33333333-3333-4333-8333-333333333333";
	const stale = await fresh([], root, freshId);
	stale.dialogs.choose = options => options[0];
	stale.dialogs.beforeSelect = async () => stale.emit("session_shutdown");
	await stale.command("plan", "clone"); assert(!existsSync(getPlanPath(root, freshId)));
	await stale.emit("agent_settled"); await blocked(stale, getPlanPath(root, freshId));
	const legacyRoot = join(root, "legacy"); mkdirSync(join(legacyRoot, ".pi"), { recursive: true });
	save(planText, join(legacyRoot, ".pi", "plan.md"));
	const legacy = await fresh([{ type: "custom", customType: "plan-mode", data: { executing: true, todos: [{ step: 1, text: "old", completed: true }] } }], legacyRoot);
	await legacy.command("todos", "show"); assert.equal(preview(legacy), undefined);
	legacy.dialogs.choose = options => options[0]; await legacy.command("plan", "clone");
	assert.equal(readFileSync(getPlanPath(legacyRoot, SESSION_A), "utf8"), planText);

	// Safe stop barriers, failed waits and queue protection.
	await h.command("plan"); await h.command("implement");
	h.setIdle(false); h.setPending(true);
	const beforeQueue = h.sent.length;
	await h.command("discuss", "off"); await blocked(h);
	assert.equal(h.sent.length, beforeQueue);
	await h.emit("agent_settled"); await blocked(h);
	h.setPending(false); await h.command("discuss", "off"); await allowed(h);
	await h.command("plan");
	h.ctx.waitForIdle = async () => { throw Error("test wait failure"); };
	await h.command("discuss", "off"); await blocked(h);
	h.ctx.waitForIdle = oldWait; await h.command("discuss", "off"); await allowed(h);
	const concurrent = await fresh();
	let release;
	concurrent.ctx.waitForIdle = () => new Promise(resolve => { release = resolve; });
	const first = concurrent.command("plan");
	await Promise.resolve(); await concurrent.command("discuss", "off"); await blocked(concurrent);
	release(); await first; assert.equal(stage(concurrent), "plan"); assert.equal(concurrent.sent.length, 1);
	const interrupted = await fresh();
	interrupted.ctx.waitForIdle = async () => { await interrupted.emit("session_shutdown"); };
	await interrupted.command("plan"); assert.equal(interrupted.sent.length, 0);

	// Startup failure before/after preparation retains plan intent, never executes.
	for (const phase of ["before", "after"]) {
		for (const mode of ["plan", "implement"]) {
			const failed = await fresh();
			await failed.command("plan");
			failed.failStartup = phase;
			await failed.command(mode);
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.equal(stage(failed), "plan"); await allowed(failed, planPath); await blocked(failed);
		}
	}
	// Startup flag and keyboard toggle never author or implement.
	const startup = await fresh();
	assert.deepEqual([...startup.flags.keys()], ["discuss-plan"]);
	startup.flags.set("discuss-plan", true); await startup.emit("session_start");
	await blocked(startup, planPath); assert.match(await startup.prompt(), /Stage: DISCUSS/);
	await startup.shortcuts[0].handler(startup.ctx); await allowed(startup);
	await startup.shortcuts[0].handler(startup.ctx); await blocked(startup, planPath);
	assert.equal(startup.sent.length, 0);
	// Disk changes revoke active execution before another code mutation.
	const snapshot = await fresh(); await snapshot.command("plan"); await snapshot.command("implement");
	save(planText + "\nChanged externally\n");
	await blocked(snapshot); assert(snapshot.aborted); await snapshot.emit("agent_settled"); await blocked(snapshot); await blocked(snapshot, planPath);
	// Clear only the owner; clear state remains empty after stale completion and reload.
	await cloner.command("implement");
	await cloner.done("[DONE:1]");
	await cloner.command("todos", "show");
	const sourceUnchanged = readFileSync(planPath, "utf8"), clearSent = cloner.sent.length;
	await cloner.command("plan", "clear");
	assert(!existsSync(otherPath)); assert.equal(readFileSync(planPath, "utf8"), sourceUnchanged);
	assert.equal(stage(cloner), "discuss"); assert.equal(cloner.sent.length, clearSent);
	assert.deepEqual(latest(cloner).todos, []); assert.equal(latest(cloner).planHash, undefined); assert.equal(preview(cloner), undefined);
	await cloner.done("[DONE:2]"); await cloner.emit("agent_settled");
	await cloner.command("plan", "clear"); assert.deepEqual(latest(cloner).todos, []);
	const cleared = await fresh(cloner.saved, root, SESSION_B);
	await cleared.command("todos", "show"); assert.equal(preview(cleared), undefined);
	const missing = await fresh(h.saved); await missing.command("todos", "show");
	rmSync(planPath); await missing.command("todos", "show"); assert.equal(preview(missing), undefined);
	console.log("PASS: commands/parsing; persistent plan permissions; mode-based implement; off; clear isolation/idempotence; clone/cancel/overwrite; language; progress; restoration/migration/branch/session isolation; startup failures; stop/queue/concurrency/stale callbacks; snapshot protection; todo viewer.");
} finally {
	for (const h of all) await h.emit("session_shutdown");
	rmSync(root, { recursive: true, force: true });
}
