import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Child } from "./background.ts";

type State = "running" | "completed" | "failed" | "cancelled";
interface Run {
	id: number;
	prompt: string;
	model?: string;
	session?: string;
	state: State;
	started: number;
	ended?: number;
	latest: string;
}

const labels: Record<State, string> = {
	running: "running", completed: "completed", failed: "failed", cancelled: "cancelled",
};
const clean = (text: string, limit = 100) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);

export function registerSubagentStatus(pi: ExtensionAPI, saved: (ctx: ExtensionContext) => Child[]) {
	const runs: Run[] = [];
	let nextId = 0;
	let ui: ExtensionContext["ui"] | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stopTimer = () => { if (timer) clearInterval(timer); timer = undefined; };

	function render() {
		if (!ui) return;
		const running = runs.filter((run) => run.state === "running").length;
		const visible = [...runs].sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.id - a.id).slice(0, 5);
		ui.setWidget("subagent-status", (_tui, theme) => ({
			render(width) {
				const header = theme.fg("accent", "◈ Subagents") + theme.fg("muted", `  ${running} running · ${runs.length - running} finished`);
				const lines = [truncateToWidth(header, width)];
				if (visible.length === 0) lines.push(truncateToWidth(theme.fg("muted", "  No subagent tasks yet"), width));
				for (const run of visible) {
					const seconds = Math.max(0, Math.floor(((run.ended ?? Date.now()) - run.started) / 1000));
					const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
					const color = run.state === "running" ? "warning" : run.state === "completed" ? "success" : run.state === "cancelled" ? "muted" : "error";
					const icon = run.state === "running" ? "●" : run.state === "completed" ? "✓" : run.state === "cancelled" ? "–" : "×";
					const prefix = `${icon} #${run.id} `;
					const suffix = `  ${labels[run.state]} ${duration}`;
					const budget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
					const title = (run.session ? `${clean(run.session, 40)} · ` : "") + run.prompt;
					const body = title + (run.state === "running" && width >= 90 ? ` · ${run.latest}` : "");
					lines.push(truncateToWidth(theme.fg(color, prefix) + truncateToWidth(body, budget, "…", true) + theme.fg(color, suffix), width));
				}
				if (runs.length > visible.length) lines.push(truncateToWidth(theme.fg("muted", `  +${runs.length - visible.length} more · /subagent to collapse`), width));
				return lines;
			},
			invalidate() {},
		}), { placement: "belowEditor" });
		if (running > 0 && !timer) {
			timer = setInterval(render, 1000);
			timer.unref();
		} else if (running === 0) stopTimer();
	}

	pi.registerCommand("subagent", {
		description: "Expand/collapse subagent status (does not cancel tasks)",
		handler: async (args, ctx) => {
			if (args.trim() === "hide" || (ui && !args.trim())) {
				ui = undefined;
				stopTimer();
				ctx.ui.setWidget("subagent-status", undefined);
				return;
			}
			if (!ctx.hasUI) return;
			ui = ctx.ui;
			for (const child of saved(ctx)) {
				if (runs.some((run) => run.session === child.session)) continue;
				runs.push({ id: ++nextId, prompt: clean(child.prompt, 70), model: child.model, session: child.session,
					state: child.state, started: Date.now(), ended: child.state === "running" ? undefined : Date.now(), latest: clean(child.result ?? child.prompt) });
			}
			render();
		},
	});
	pi.on("session_start", () => { runs.length = 0; nextId = 0; });
	pi.on("session_shutdown", () => { ui?.setWidget("subagent-status", undefined); ui = undefined; stopTimer(); });

	return {
		start(prompt: string, model?: string, session?: string) {
			const run: Run = { id: ++nextId, prompt: clean(prompt, 70), model, session, state: "running", started: Date.now(), latest: "Starting" };
			runs.push(run);
			render();
			return {
				update(latest: string) { run.latest = clean(latest); render(); },
				finish(state: Exclude<State, "running">, latest?: string) {
					run.state = state;
					run.ended = Date.now();
					if (latest) run.latest = clean(latest);
					// Retain recent history without ever discarding an active run.
					while (runs.length > 50) {
						const index = runs.findIndex((item) => item.state !== "running");
						if (index < 0) break;
						runs.splice(index, 1);
					}
					render();
				},
			};
		},
	};
}
