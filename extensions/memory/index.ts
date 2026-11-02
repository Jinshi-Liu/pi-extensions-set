import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function memory(pi: ExtensionAPI) {
	let enabled = false;
	const publish = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("memory", ctx.ui.theme.fg("dim", enabled ? "Memory: ON" : "Memory: OFF"));
	};

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		publish(ctx);
	});

	pi.registerCommand("memory", {
		description: "Toggle memory context (off by default)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			publish(ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!enabled) {
			delete event.systemPromptOptions.sections.memory;
			return;
		}
		const indexPath = join(homedir(), ".pi", "agent", "memory", "index.md");
		let index: string;
		try {
			index = readFileSync(indexPath, "utf8");
		} catch (error) {
			index = (error as NodeJS.ErrnoException).code === "ENOENT"
				? "(Memory index does not exist yet.)"
				: "(Memory index could not be read.)";
		}
		// Refresh the index each run; linked memories and rules remain on demand.
		event.systemPromptOptions.sections.memory =
			`Memory index: ${indexPath}\nBefore modifying memory, read: ${fileURLToPath(new URL("./memory-rules.md", import.meta.url))}\n\n${index}`;
	});
}
