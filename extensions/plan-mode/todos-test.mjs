import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const install = process.env.PI_TEST_INSTALL ?? join(homedir(), ".pi/agent/install/releases/1.4.0/node_modules");
const { createJiti } = await import(pathToFileURL(join(install, "jiti/lib/jiti.mjs")));
const tui = await import(pathToFileURL(join(install, "@earendil-works/pi-tui/dist/index.js")));
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-tui": join(install, "@earendil-works/pi-tui/dist/index.js") },
	moduleCache: false,
});
const { cleanStepText, extractTodoItems, markCompletedSteps } = await jiti.import(fileURLToPath(new URL("./utils.ts", import.meta.url)));
const { createTodoWidget, TodoListView } = await jiti.import(fileURLToPath(new URL("./todos-ui.ts", import.meta.url)));

const theme = { fg: (_color, text) => text, strikethrough: (text) => text };
const keybindings = { matches: (data, action) => tui.matchesKey(data, { "tui.select.up": "up", "tui.select.down": "down", "tui.select.cancel": "escape" }[action]) };
let renders = 0;
const terminal = { rows: 24 };
const screen = { terminal, requestRender() { renders++; } };
const longText = "Verify the complete task description including the important identifier at the very end FINAL_IDENTIFIER";
assert.equal(cleanStepText(longText), longText, "stored steps must retain verbs and full descriptions");
const extracted = extractTodoItems(`Plan:\n${Array.from({ length: 100 }, (_, i) => `${i + 1}. ${longText} ${i + 1}`).join("\n")}`);
assert.equal(extracted.length, 100);
assert.match(extracted[99].text, /FINAL_IDENTIFIER 100$/);
assert.equal(extractTodoItems("Plan:\n1. **Update** `foo.ts` and verify the full description remains intact")[0].text,
	"Update foo.ts and verify the full description remains intact");
const structured = extractTodoItems(`## Plan:
1. **Update** the parser
   Retain the complete continuation description.
   1. Nested verification belongs to the first step.
   - Preserve all important identifiers.
2. Verify the viewer

## Notes
1. This must not become another task.`);
assert.equal(structured.length, 2);
assert.match(structured[0].text, /complete continuation description/);
assert.match(structured[0].text, /Nested verification/);
assert.match(structured[0].text, /important identifiers/);
assert(!structured.some((item) => item.text.includes("must not")));
assert.equal(extractTodoItems("**Plan:**\r\n  1. Verify the parser\r\n  2. Verify the UI\r\nSummary:\r\n1. Not a task").length, 2);
assert.deepEqual(extractTodoItems("Plan:\nNo plan is needed.\nSummary:\n1. An unrelated item"), []);
assert.equal(markCompletedSteps("[DONE:1] [DONE:2]", extracted), 2);
assert(extracted[0].completed);

let items = Array.from({ length: 100 }, (_, i) => ({ step: i + 1, text: `Task number ${i + 1}`, completed: i < 70 }));
const widget = createTodoWidget(() => items, screen, theme);
assert.equal(widget.render(120).length, 7);
assert.match(widget.render(120).join("\n"), /71\. Task number 71/);
assert.match(widget.render(120).at(-1), /\/todos all/);
for (const width of [1, 8, 20, 80]) for (const rows of [8, 12, 24, 50]) {
	terminal.rows = rows;
	const lines = widget.render(width);
	assert(lines.length <= 7);
	assert(lines.every((line) => tui.visibleWidth(line) <= width));
}
items.forEach((item) => { item.completed = true; });
assert.match(widget.render(100).join("\n"), /100\. Task number 100/);
items = [];
assert.deepEqual(widget.render(100), []);

terminal.rows = 24;
items = extracted;
let closed = false;
const view = new TodoListView(() => items, screen, theme, keybindings, () => { closed = true; });
let lines = view.render(80);
assert(lines.length <= Math.floor(terminal.rows * 0.8));
assert.match(lines.join("\n"), /1\. Verify the complete/);
view.handleInput("\x1b[6~"); // PageDown
assert(renders > 0);
assert.notEqual(view.render(80).join("\n"), lines.join("\n"));
view.handleInput("\x1b[F"); // End
lines = view.render(80);
assert.match(lines.join("\n"), /FINAL_IDENTIFIER 100/);
view.handleInput("\x1b[H"); // Home
assert.match(view.render(80).join("\n"), /1\. Verify the complete/);
view.handleInput("\x1b[B");
assert.match(view.render(80).at(-1), /^Lines 2-/);
view.handleInput("\x1b[A");
assert.match(view.render(80).at(-1), /^Lines 1-/);
view.handleMouse({ type: "wheel", wheelDelta: 3 });
assert.match(view.render(80).at(-1), /^Lines 4-/);
view.handleInput("\x1b[5~"); // PageUp
assert.match(view.render(80).at(-1), /^Lines 1-/);
for (const width of [1, 8, 20, 80]) for (const rows of [1, 4, 8, 24]) {
	terminal.rows = rows;
	lines = view.render(width);
	assert(lines.length <= Math.max(1, Math.floor(rows * 0.8)));
	assert(lines.every((line) => tui.visibleWidth(line) <= width));
}
terminal.rows = 24;
items = [{ step: 1, text: "Unicode compatibility 中文任务 👨‍👩‍👧‍👦 e\u0301 END", completed: false }];
view.invalidate();
assert.match(view.render(100).join("\n"), /END/);
const ansiTheme = { fg: (_color, text) => `\x1b[32m${text}\x1b[39m`, strikethrough: (text) => `\x1b[9m${text}\x1b[29m` };
const ansiView = new TodoListView(() => items, screen, ansiTheme, keybindings, () => {});
const ansiWidget = createTodoWidget(() => items, screen, ansiTheme);
for (const width of [1, 8, 20, 80]) {
	assert(ansiView.render(width).every((line) => tui.visibleWidth(line) <= width));
	assert(ansiWidget.render(width).every((line) => tui.visibleWidth(line) <= width));
}
items[0].completed = true;
assert.match(view.render(100)[0], /1\/1 completed/);
view.handleInput("\x1b");
assert(closed);

console.log("PASS: 100 tasks; full text; multiline/nested steps and section boundaries; bounded preview; scrolling; resize; narrow/Unicode rendering.");
