import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const install = process.env.PI_TEST_INSTALL ?? join(homedir(), ".pi/agent/install/releases/1.5.0/node_modules");
const { createJiti } = await import(pathToFileURL(join(install, "jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { default: extension } = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));
const { buildSystemPrompt, buildSystemPromptSections, diffSystemPromptSections } = await import(pathToFileURL(join(install, "@earendil-works/pi-coding-agent/dist/core/system-prompt.js")));
const root = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = join(root, "home");
process.env.USERPROFILE = join(root, "home");

function harness(hasUI = true) {
	const events = new Map(), commands = new Map(), statuses = new Map();
	// No tool, persistence, or messaging APIs: unexpected calls fail.
	extension({
		on(name, fn) { events.set(name, fn); },
		registerCommand(name, command) { commands.set(name, command); },
	});
	const ctx = {
		cwd: join(root, "project"), hasUI,
		ui: hasUI ? {
			theme: { fg(color, text) { assert.equal(color, "dim"); return text; } },
			setStatus: (key, value) => statuses.set(key, value),
		} : {},
	};
	const options = { cwd: ctx.cwd, selectedTools: ["read", "write", "edit"], sections: { plan_workflow: "Read-only workflow", unrelated: "Unchanged" }, contextFiles: [], skills: [] };
	return {
		ctx, options, events, commands, statuses,
		start(reason) { return events.get("session_start")({ type: "session_start", reason }, ctx); },
		toggle() { return commands.get("memory").handler("", ctx); },
		prompt() {
			assert.equal(events.get("before_agent_start")({ systemPromptOptions: options }, ctx), undefined);
			return buildSystemPrompt(options);
		},
	};
}

try {
	assert.equal(homedir(), join(root, "home"));
	const h = harness();
	assert.deepEqual([...h.commands.keys()], ["memory"]);
	assert.deepEqual([...h.events.keys()], ["session_start", "before_agent_start"]);
	const baseline = buildSystemPrompt(h.options);
	assert.equal(h.prompt(), baseline, "OFF contributes no prompt");
	await h.start("startup");
	assert.equal(h.statuses.get("memory"), "Memory: OFF");
	assert.equal(h.commands.get("memory").description, "Toggle memory context (off by default)");
	await h.toggle();
	assert.equal(h.statuses.get("memory"), "Memory: ON");
	const on = h.prompt();
	const index = join(homedir(), ".pi", "agent", "memory", "index.md");
	const rules = fileURLToPath(new URL("./memory-rules.md", import.meta.url));
	const header = `Memory index: ${index}\nBefore modifying memory, read: ${rules}`;
	const expected = `${header}\n\n(Memory index does not exist yet.)`;
	assert.equal(h.options.sections.memory, expected);
	assert(!on.includes(JSON.stringify(join(h.ctx.cwd, ".pi", "memory", "index.md"))));
	assert.deepEqual(readdirSync(root), [], "Startup, toggle, and prompt do not create stores");
	for (let i = 0; i < 20; i++) assert.equal(h.prompt(), on);
	const sections = buildSystemPromptSections(h.options);
	assert.equal(diffSystemPromptSections(sections, buildSystemPromptSections(h.options)), undefined);
	await h.toggle();
	assert.equal(h.prompt(), baseline);
	assert(!Object.hasOwn(h.options.sections, "memory"));
	assert.deepEqual(diffSystemPromptSections(sections, buildSystemPromptSections(h.options)), { memory: null });
	assert.deepEqual(h.options.selectedTools, ["read", "write", "edit"]);
	assert.equal(h.options.sections.plan_workflow, "Read-only workflow");
	assert.equal(h.options.sections.unrelated, "Unchanged");

	for (const reason of ["new", "resume", "reload", "startup"]) {
		await h.toggle();
		assert.equal(h.prompt(), on);
		await h.start(reason);
		assert.equal(h.prompt(), baseline);
		assert.equal(h.statuses.get("memory"), "Memory: OFF");
	}
	await h.toggle();
	assert.equal(harness().prompt(), baseline, "A new runtime does not inherit ON");
	const headless = harness(false);
	await headless.start("startup");
	await headless.toggle();
	assert.equal(headless.prompt(), on);
	await headless.toggle();
	assert.equal(headless.prompt(), baseline);

	// Only synthetic files in a temporary home; no real memories are inspected.
	mkdirSync(join(index, ".."), { recursive: true });
	writeFileSync(index, "- [Profile](profile.md): Fixture summary");
	writeFileSync(join(index, "..", "profile.md"), "SECRET_FIXTURE_PROFILE");
	const populated = h.prompt();
	assert.equal(h.options.sections.memory, `${header}\n\n- [Profile](profile.md): Fixture summary`);
	assert(!populated.includes("SECRET_FIXTURE_PROFILE"), "Linked files are not loaded");
	assert(!populated.includes("# Memory Maintenance Rules"), "Rule contents are not loaded");
	writeFileSync(index, "Updated index");
	h.prompt();
	assert.equal(h.options.sections.memory, `${header}\n\nUpdated index`, "Each run refreshes the index");
	const originalCwd = h.ctx.cwd;
	h.ctx.cwd = join(root, "another-project");
	h.prompt();
	assert.equal(h.options.sections.memory, `${header}\n\nUpdated index`, "The index is global, independent of project");
	h.ctx.cwd = originalCwd;
	await h.toggle();
	assert.equal(h.prompt(), baseline, "OFF with existing memory still contributes nothing");
	await h.toggle();
	writeFileSync(index, "");
	h.prompt();
	assert.equal(h.options.sections.memory, `${header}\n\n`, "Empty index is valid");
	rmSync(index);
	mkdirSync(index);
	h.prompt();
	assert.equal(h.options.sections.memory, `${header}\n\n(Memory index could not be read.)`, "Read errors do not preserve stale content or crash the run");
	await h.toggle();
	assert.equal(h.prompt(), baseline);
	console.log("PASS: OFF has no context; ON injects fresh index only; missing/empty/unreadable index; lifecycle resets; dim status; headless; unchanged tools and workflow guidance.");
	console.log("Not tested: interactive terminal rendering or model adherence to on-disk maintenance rules. Lifecycle events are simulated.");
} finally {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
