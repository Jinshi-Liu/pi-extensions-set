/** discuss-plan: read-only discussion, persistent plan authoring, explicit implementation. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Key } from "@earendil-works/pi-tui";
import { createTodoWidget, TodoListView } from "./todos-ui.ts";
import { markCompletedSteps, type TodoItem } from "./utils.ts";
import {
	STATE_TYPE, LEGACY_STATE_TYPE, DISCUSS_ACTIONS, PLAN_USAGE, TODOS_USAGE, PLAN_ACTIONS, TODO_ACTIONS,
	completions, parsePlanArgs, withPlanPrompt, isDelegationTool, isPlanPath, isResearchCommand, isResearchTool,
	isScopedPlanPath, isForeignPlanPath, searchesPlanStorage, listCloneSources, readCloneSource,
	planPath, projectKey, readPlan, stageGuidance,
	type SavedPlan, type Stage, type WorkflowState,
} from "./workflow.ts";

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}
function getTextContent(message: AssistantMessage): string {
	return message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
}
function copyTodos(value: unknown): TodoItem[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => item && typeof item.text === "string" && Number.isInteger(item.step) && item.step > 0)
		.map((item) => ({ step: item.step, text: item.text, completed: item.completed === true }));
}

export default function discussPlanExtension(pi: ExtensionAPI): void {
	let stage: Stage = "off";
	let disposed = false;
	let todoItems: TodoItem[] = [];
	let todosVisible = false;
	let savedPlan: SavedPlan | undefined;
	let project = "";
	let ownerSessionId = "";
	let clonePending = false;
	let interaction = 0;
	function ownPath(ctx: ExtensionContext): string { return planPath(ctx.cwd, ownerSessionId); }
	function currentIdentity(ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getSessionId() === ownerSessionId && projectKey(ctx.cwd) === project;
	}
	function noSessionPlan(ctx: ExtensionContext): string {
		return `No session plan at ${ownPath(ctx)}. Use /plan or /plan clone.`;
	}
	let stopping = false;
	let commandStopping = false;
	let trackStoppedExecution = false;
	let generation = 0;
	let startupWatch: ReturnType<typeof setTimeout> | undefined;
	function clearStartupWatch(): void {
		if (startupWatch) clearTimeout(startupWatch);
		startupWatch = undefined;
	}
	// sendMessage is fire-and-forget. Preparation failures return to idle without
	// agent_settled, so watch only the interval before agent_start takes ownership.
	function watchStartup(ctx: ExtensionContext, expected: "plan" | "execute"): void {
		clearStartupWatch();
		const epoch = generation;
		const check = () => {
			startupWatch = undefined;
			if (epoch !== generation || !currentIdentity(ctx) || stage !== expected || stopping) return;
			if (ctx.isIdle()) {
				stage = "plan";
				publish(ctx);
				notify(ctx, "The requested run did not start. Plan mode retained; use /plan or /implement to retry.", true);
				return;
			}
			startupWatch = setTimeout(check, 50);
			startupWatch.unref();
		};
		startupWatch = setTimeout(check, 50);
		startupWatch.unref();
	}

	pi.registerFlag("discuss-plan", { description: "Start in read-only design discussion", type: "boolean", default: false });

	function persistState(): void {
		pi.appendEntry<WorkflowState>(STATE_TYPE, {
			version: 2, project, ownerSessionId,
			// Persist intent; execution restores as plan mode without starting a run.
			stage,
			todos: todoItems.map((item) => ({ ...item })),
			planHash: savedPlan?.hash, todosVisible,
		});
	}
	function updateStatus(ctx: ExtensionContext): void {
		const completed = todoItems.filter((item) => item.completed).length;
		const label = stopping ? "stopping" : stage === "off" ? undefined :
			`${stage === "execute" ? "implement" : stage}${todoItems.length ? ` ${completed}/${todoItems.length}` : ""}`;
		ctx.ui.setStatus("discuss-plan", label ? ctx.ui.theme.fg("mdLink", label) : undefined);
		ctx.ui.setWidget("plan-todos", todosVisible && todoItems.length ?
			(tui, theme) => createTodoWidget(() => todoItems, tui, theme) : undefined);
	}
	function publish(ctx: ExtensionContext): void { updateStatus(ctx); persistState(); }
	function notify(ctx: ExtensionContext, message: string, error = false): void {
		ctx.ui.notify(message, error ? "error" : "info");
	}
	function adoptPlan(plan: SavedPlan | undefined): void {
		savedPlan = plan;
		// No fallback to historical todos when the owned file is missing or has no tasks.
		todoItems = plan?.todos ?? [];
	}
	function reloadPlan(ctx: ExtensionContext): SavedPlan | undefined {
		let plan: SavedPlan | undefined;
		try { plan = readPlan(ctx.cwd, ownerSessionId, todoItems); }
		catch (error) {
			adoptPlan(undefined);
			updateStatus(ctx);
			throw error;
		}
		if (plan?.todos.length) {
			const removed = todoItems.filter((item) => item.completed).length - plan.todos.filter((item) => item.completed).length;
			if (removed > 0) notify(ctx, `${removed} previously completed task description(s) changed or were removed. Unchanged tasks retain progress; revised tasks need verification before being marked complete.`);
		}
		adoptPlan(plan);
		updateStatus(ctx);
		return plan;
	}
	/** Lock before abort, and never grant new permissions to queued work. */
	async function stop(ctx: ExtensionCommandContext, target: "off" | "discuss" | "plan"): Promise<boolean> {
		if (stopping) { notify(ctx, "A safe stop is already in progress. Clear queued messages and retry after settlement."); return false; }
		const epoch = generation;
		clearStartupWatch();
		commandStopping = true;
		stopping = true;
		trackStoppedExecution = stage === "execute";
		// Persist the intended non-executing mode while tools remain locked.
		stage = target;
		publish(ctx);
		try {
			ctx.abort();
			await ctx.waitForIdle();
			if (epoch !== generation || !currentIdentity(ctx)) return false;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				notify(ctx, "Queued work remains. Tool access stays locked; clear queued messages, then retry the command.", true);
				return false;
			}
			try { reloadPlan(ctx); } catch (error) { notify(ctx, `Cannot reload saved plan: ${String(error)}`, true); }
			stopping = false;
			trackStoppedExecution = false;
			publish(ctx);
			return true;
		} catch (error) {
			if (epoch === generation) notify(ctx, `Stop could not confirm idle; tool access remains locked: ${String(error)}`, true);
			return false;
		} finally {
			if (epoch === generation) commandStopping = false;
		}
	}
	function idleForGrant(ctx: ExtensionContext): boolean {
		if (clonePending || stopping || !ctx.isIdle() || ctx.hasPendingMessages()) {
			notify(ctx, "This command requires an idle agent with no queued messages. Use /discuss to stop first.");
			return false;
		}
		return true;
	}
	function startPlan(ctx: ExtensionCommandContext, prompt = ""): void {
		if (!idleForGrant(ctx)) return;
		stage = "plan";
		try { reloadPlan(ctx); }
		catch (error) { publish(ctx); notify(ctx, `Cannot open session plan: ${String(error)}`, true); return; }
		publish(ctx);
		watchStartup(ctx, "plan");
		try {
			pi.sendMessage({
				customType: "discuss-plan-author", display: true, details: { ownerSessionId, project },
				content: withPlanPrompt(`Create or revise this session's only plan at ${ownPath(ctx)} from the discussion, following the user's language preferences. Only this plan may be edited; do not implement. Preserve unchanged task wording and completed progress. Stay in plan mode for further revisions; /implement executes the saved plan.`, prompt),
			}, { triggerTurn: true });
		} catch (error) {
			clearStartupWatch();
			notify(ctx, `Could not start plan authoring; plan mode retained: ${String(error)}`, true);
		}
	}
	function startExecute(ctx: ExtensionCommandContext, prompt = ""): void {
		if (!idleForGrant(ctx)) return;
		const oldHash = savedPlan?.hash;
		let plan: SavedPlan | undefined;
		try { plan = reloadPlan(ctx); }
		catch (error) { stage = "plan";  publish(ctx); notify(ctx, `Cannot open saved plan: ${String(error)}`, true); return; }
		if (!plan?.todos.length) {
			stage = "plan";
			notify(ctx, plan ? `No executable task list in ${ownPath(ctx)}. Use /plan to write a 'Plan:' numbered task list.` : noSessionPlan(ctx));
			publish(ctx); return;
		}
		if (oldHash && oldHash !== plan.hash) notify(ctx, "Saved plan changed; reloaded it and retained completion for unchanged task text.");
		if (todoItems.every((item) => item.completed)) {
			stage = "plan";
			notify(ctx, "All saved steps are already complete. Use /plan to revise the plan.");
			publish(ctx); return;
		}
		stage = "execute";

		publish(ctx);
		watchStartup(ctx, "execute");
		try {
			pi.sendMessage({ customType: "discuss-plan-execute", display: true, details: { ownerSessionId, project },
				content: withPlanPrompt(`Execute the saved ${ownPath(ctx)} plan, continuing only unfinished steps. Verify each step and report [DONE:n]. Do not change the plan file. If redesign is needed, suggest /plan.`, prompt) },
				{ triggerTurn: true });
		} catch (error) {
			stage = "plan"; publish(ctx);
			notify(ctx, `Could not start execution: ${String(error)}`, true);
		}
	}

	async function clonePlan(ctx: ExtensionCommandContext): Promise<void> {
		if (stage === "execute") {
			notify(ctx, "Cloning requires an idle agent outside execution. Use /plan or /discuss first."); return;
		}
		if (!idleForGrant(ctx)) return;
		if (!ctx.hasUI) { notify(ctx, "Plan cloning requires a plan chooser UI.", true); return; }
		const epoch = generation, token = interaction, id = ownerSessionId, root = ctx.cwd;
		const current = () => epoch === generation && token === interaction && currentIdentity(ctx);
		const ready = () => current() && !stopping && stage !== "execute" && ctx.isIdle() && !ctx.hasPendingMessages();
		clonePending = true;
		try {
			const sources = listCloneSources(root, id);
			if (!sources.length) { notify(ctx, "No other saved project plans to clone. Use /plan."); return; }
			const labels = sources.map((source) => `${source.title} — ${source.sessionId ? `session ${source.sessionId}` : "legacy plan"}`);
			const selected = await ctx.ui.select("Clone a saved project plan", labels);
			if (selected === undefined || !current()) return;
			if (!ready()) { notify(ctx, "Clone cancelled: agent is busy. Use /discuss, then retry."); return; }
			const source = sources[labels.indexOf(selected)];
			if (!source) return;
			const destination = planPath(root, id);
			const expectedHash = readPlan(root, id)?.hash;
			if (expectedHash !== undefined) {
				const confirmed = await ctx.ui.confirm("Overwrite this session's plan?", `Copy ${source.path} into ${destination}? All session task progress will reset. This does not execute the plan.`);
				if (!confirmed || !current()) return;
			}
			await withFileMutationQueue(destination, async () => {
				if (!ready()) return;
				if (readPlan(root, id)?.hash !== expectedHash) throw new Error("The owned plan changed while choosing. Retry /plan clone to confirm the current file.");
				const text = readCloneSource(root, id, source);
				// No await between the identity check and mutation: a replaced context cannot write.
				mkdirSync(dirname(destination), { recursive: true });
				writeFileSync(destination, text, "utf8");
				clearStartupWatch();
				todoItems = []; savedPlan = undefined;
				adoptPlan(readPlan(root, id));
				stage = "plan";
				publish(ctx);
				notify(ctx, `Plan cloned to ${destination}. Progress reset; plan mode. Use /implement to run it or /plan to revise it.`);
			});
		} catch (error) {
			if (current()) notify(ctx, `Cannot clone plan: ${String(error)}`, true);
		} finally {
			if (epoch === generation && token === interaction) clonePending = false;
		}
	}

	async function clearPlan(ctx: ExtensionCommandContext): Promise<void> {
		if (!await stop(ctx, "discuss")) return;
		const epoch = generation, token = interaction, destination = ownPath(ctx);
		try {
			await withFileMutationQueue(destination, async () => {
				if (epoch !== generation || token !== interaction || !currentIdentity(ctx) || stopping || !ctx.isIdle() || ctx.hasPendingMessages()) return;
				if (!isScopedPlanPath(ctx.cwd, ownerSessionId, destination)) throw new Error("Plan storage must not be redirected by a symlink.");
				let existed = true;
				try { unlinkSync(destination); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") existed = false; else throw error; }
				adoptPlan(undefined); todosVisible = false;
				publish(ctx);
				notify(ctx, existed ? "Session plan and progress cleared. Discussion mode; implemented code is unchanged." : "No session plan to clear. Progress cleared; discussion mode.");
			});
		} catch (error) {
			if (epoch === generation) notify(ctx, `Cannot clear session plan: ${String(error)}`, true);
		}
	}
	for (const command of ["plan", "discuss"] as const) pi.registerCommand(command, {
		description: command === "plan" ? "Create or revise this session's plan; off, clone, clear, help" : "Enter read-only discussion; off, help",
		getArgumentCompletions: (prefix) => completions(command === "plan" ? PLAN_ACTIONS : DISCUSS_ACTIONS, prefix),
		handler: async (args, ctx) => {
			if (!currentIdentity(ctx)) restore(ctx);
			const { action, prompt } = parsePlanArgs(args, command);
			if (action !== "prompt" && prompt) { notify(ctx, PLAN_USAGE); return; }
			if (action === "help") { notify(ctx, PLAN_USAGE); return; }
			if (action === "clone" && clonePending) { notify(ctx, "A clone chooser is already open."); return; }
			if (stopping) {
				// A failed stop can be retried once the old run and its queue are gone.
				if (commandStopping || !ctx.isIdle() || ctx.hasPendingMessages()) { notify(ctx, "Stop pending. Clear queued messages and wait for idle."); return; }
				stopping = false; trackStoppedExecution = false;
			}
			interaction++;
			if (action === "clone") { await clonePlan(ctx); return; }
			clonePending = false; // Supersede any outstanding chooser without adopting its result.
			if (action === "clear") { await clearPlan(ctx); return; }
			if (action === "off") {
				if (await stop(ctx, "off")) notify(ctx, "discuss-plan off. Normal tool access restored; no implementation started.");
				return;
			}
			if (!await stop(ctx, command === "plan" ? "plan" : "discuss")) return;
			if (command === "plan") startPlan(ctx, prompt);
			else if (prompt) pi.sendUserMessage(prompt);
			else notify(ctx, "Discussion mode (read-only). Use /plan to draft or /implement to implement the discussion.");
		},
	});
	pi.registerCommand("implement", {
		description: "Implement the discussion directly, or execute the saved plan when in plan mode",
		handler: async (args, ctx) => {
			if (!currentIdentity(ctx)) restore(ctx);
			if (stopping || clonePending) { notify(ctx, "Wait for the current workflow operation to finish."); return; }
			if (stage === "execute") { notify(ctx, "Plan execution is already authorized. Use /plan to stop and revise."); return; }
			interaction++;
			const mode = stage;
			const prompt = args.trim().replace(/^--(?:\\s+|$)/, "");
			if (!await stop(ctx, mode === "plan" ? "plan" : "off")) return;
			if (mode === "plan") startExecute(ctx, prompt);
			else pi.sendUserMessage(withPlanPrompt(mode === "discuss" ? "Implement the plan we just discussed." :
				"Implement the current user request. If no clear task has been established, ask for clarification. Do not discover or automatically execute an old saved plan.", prompt));
		},
	});

	pi.registerCommand("todos", {
		description: "Toggle the compact task panel; all opens the full scrollable list",
		getArgumentCompletions: (prefix) => completions(TODO_ACTIONS, prefix),
		handler: async (args, ctx) => {
			if (!currentIdentity(ctx)) restore(ctx);
			const action = args.trim().toLowerCase();
			if (!["", "all", "show", "hide", "help"].includes(action)) { notify(ctx, TODOS_USAGE); return; }
			if (action === "help") { notify(ctx, `${TODOS_USAGE} /todos toggles the compact panel; all opens the full list.`); return; }
			if (action === "hide") { todosVisible = false; publish(ctx); return; }
			if (!stopping && stage !== "execute") {
				try { reloadPlan(ctx); }
				catch (error) { notify(ctx, `Cannot reload saved todos: ${String(error)}`, true); }
			}
			if (!savedPlan) { notify(ctx, noSessionPlan(ctx)); return; }
			if (todoItems.length === 0) { notify(ctx, `No todos in ${ownPath(ctx)}. Use /plan.`); return; }
			if (action === "all") {
				if (ctx.mode !== "tui") { notify(ctx, "The full todo list requires interactive terminal mode."); return; }
				await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
					new TodoListView(() => todoItems, tui, theme, keybindings, done),
					{ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } });
				return;
			}
			todosVisible = action === "show" || !todosVisible;
			publish(ctx);
		},
	});
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle off/discuss (idle only; use /discuss while busy)",
		handler: async (ctx) => {
			if (!currentIdentity(ctx)) restore(ctx);
			if (!idleForGrant(ctx)) return;
			interaction++;
			stage = stage === "off" ? "discuss" : "off";
			publish(ctx);
			notify(ctx, stage === "off" ? "Plan workflow off." : "Discussion mode (read-only). Use /plan when ready.");
		},
	});

	function invalidateExecution(ctx: ExtensionContext, reason: string): void {
		// Keep the protected execution stage: only an explicit /plan grants editing.
		// Snapshot checks reject tools after settlement until the user switches.
		stopping = true;
		trackStoppedExecution = false;
		publish(ctx);
		ctx.abort();
		notify(ctx, `${reason} Execution stopped; progress retained. Use /plan to review and revise, or /discuss to discuss.`, true);
	}
	function checkSnapshot(ctx: ExtensionContext): boolean {
		if (stage !== "execute") return true;
		try {
			const current = readPlan(ctx.cwd, ownerSessionId, todoItems);
			if (!current || current.hash !== savedPlan?.hash) {
				invalidateExecution(ctx, "The saved plan changed or disappeared on disk."); return false;
			}
		} catch (error) { invalidateExecution(ctx, `Cannot verify the saved plan: ${String(error)}`); return false; }
		return true;
	}

	// Nested calls (including codemode) pass through the same hook. Never trust the outer call alone.
	pi.on("tool_call", (event, ctx) => {
		const block = (reason: string) => ({ block: true, reason });
		if (!currentIdentity(ctx)) return block("Session/project identity changed. Retry with the current session context.");
		if (stopping) return block("Plan workflow is stopping. All further tool calls are blocked until abort settles.");
		if (stage === "off") return;
		if (!checkSnapshot(ctx)) return block("Plan snapshot changed. Execution authorization revoked.");
		const name = event.toolName;
		const input = event.input as Record<string, unknown>;
		const pathKeys = ["path", "file", "filePath", "destination", "target", "source", "sourcePath", "targetPath", "directory", "cwd"];
		for (const key of pathKeys) {
			if (isForeignPlanPath(ctx.cwd, ownerSessionId, input[key]))
				return block(`Only this session's plan is accessible: ${ownPath(ctx)}. Use the explicit /plan clone chooser to copy another plan.`);
		}
		if (name === "grep" && searchesPlanStorage(ctx.cwd, input.path))
			return block(`Recursive searches here could read other session plans. Search specific code files/directories, or read ${ownPath(ctx)} directly.`);
		if ((name === "bash" || name === "powershell") && /(?:^|[\s/'"\\])\.pi[/\\](?:plans(?:[/\\\s'"*]|$)|plan\.md)/i.test(String(input.command ?? "")))
			return block(`Use read to inspect only ${ownPath(ctx)}; shell access to plan storage is protected.`);
		if (name === "write" || name === "edit") {
			if (stage === "plan" && isScopedPlanPath(ctx.cwd, ownerSessionId, input.path)) return;
			if (stage === "execute" && !isPlanPath(ctx.cwd, ownerSessionId, input.path)) return;
			return block(stage === "execute" ? "The plan file is protected during execution. Use /plan for redesign." :
				`Read-only discussion; /plan grants persistent write/edit access ONLY to ${ownPath(ctx)}.`);
		}
		if (isDelegationTool(name)) return block("Delegation cannot enforce this workflow's file permissions. Inspect and act with local guarded tools instead.");
		if (stage === "execute") {
			// Direct write/edit targets are checked above. Catch explicit shell and custom-tool plan targets too.
			if (name === "bash" || name === "powershell") {
				const command = String(input.command ?? "");
				if (/(?:^|[\s/'"\\])\.pi(?:[\s/'"\\]|$)/i.test(command))
					return block("Shell access to the plan path is protected during execution. Use read to inspect it; /plan to revise it.");
			}
			for (const key of pathKeys) {
				if (typeof input[key] === "string" && (isPlanPath(ctx.cwd, ownerSessionId, input[key]) || searchesPlanStorage(ctx.cwd, input[key])) && !isResearchTool(name, pi.getAllTools().find((tool) => tool.name === name)))
					return block("The saved plan is protected. Use /plan to revise it.");
			}
			return;
		}
		if (name === "bash") return isResearchCommand(input.command) ? undefined : block("Discussion/authoring allows only simple read-only shell inspection. Use read/grep/find/ls and available web research tools; no shell changes or delegation.");
		if (!isResearchTool(name, pi.getAllTools().find((tool) => tool.name === name)))
			return block(`Tool '${name}' is not a read-only research tool. ${stage === "plan" ? `Only write/edit of ${ownPath(ctx)} is authorized.` : "Discuss first; /plan authors a plan and /implement authorizes implementation."}`);
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => {
			const custom = message as AgentMessage & { customType?: string; details?: { grant?: string; ownerSessionId?: string; project?: string } };
			const type = custom.customType;
			if (type === "discuss-plan-author") return stage === "plan" && custom.details?.ownerSessionId === ownerSessionId && custom.details?.project === project;
			if (type === "discuss-plan-execute") return stage === "execute" && custom.details?.ownerSessionId === ownerSessionId && custom.details?.project === project;
			return !type || !["plan-workflow-make", "plan-workflow-execute", "plan-mode-context", "plan-execution-context", "plan-workflow-context", "plan-mode-execute"].includes(type);
		}),
	}));
	pi.on("before_agent_start", (event, ctx) => {
		if (disposed) return;
		if (!currentIdentity(ctx)) restore(ctx);
		interaction++;
		clonePending = false;
		checkSnapshot(ctx);
		const guidance = stopping ? "Plan workflow is stopping. Do not call tools or continue implementation." : stageGuidance(stage, todoItems, ctx.cwd, ownerSessionId, savedPlan);
		if (guidance) event.systemPromptOptions.sections.plan_workflow = guidance;
		else delete event.systemPromptOptions.sections.plan_workflow;
	});

	pi.on("turn_end", (event, ctx) => {
		if (disposed || !currentIdentity(ctx)) return;
		if ((stage !== "execute" && !trackStoppedExecution) || !isAssistantMessage(event.message)) return;
		if (stage === "execute" && !checkSnapshot(ctx)) return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) publish(ctx);
	});
	pi.on("agent_start", () => clearStartupWatch());
	pi.on("agent_settled", (_event, ctx) => {
		clearStartupWatch();
		if (disposed || !currentIdentity(ctx) || commandStopping) return; // The command owns its waitForIdle barrier.
		if (stopping) {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			stopping = false; trackStoppedExecution = false;
			publish(ctx); return;
		}
		if (stage === "plan") {
			try { reloadPlan(ctx); } catch (error) { notify(ctx, `Cannot read saved plan: ${String(error)}`, true); }
			publish(ctx);
		} else if (stage === "execute" && todoItems.length && todoItems.every((item) => item.completed)) {
			notify(ctx, "Plan complete. Plan and progress retained; /plan returns to plan mode for revisions.");
		}
	});

	function restore(ctx: ExtensionContext): void {
		disposed = false;
		ctx.ui.setStatus("plan-mode", undefined); // Remove a pre-migration footer on reload.
		clearStartupWatch();
		generation++;
		stopping = false; commandStopping = false; trackStoppedExecution = false;
		savedPlan = undefined; todoItems = []; todosVisible = false;
		clonePending = false;
		project = projectKey(ctx.cwd);
		ownerSessionId = ctx.sessionManager.getSessionId();
		planPath(ctx.cwd, ownerSessionId); // Never fall back to shared storage.
		stage = pi.getFlag("discuss-plan") === true ? "discuss" : "off";
		// Only the active ancestry counts; abandoned branch entries must not leak progress or grants.
		let legacyTools: string[] | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "plan-mode") {
				// Recover old tool visibility only, never unknown-owner stage or progress.
				const legacy = entry.data as { toolsBeforePlanMode?: unknown } | undefined;
				legacyTools = Array.isArray(legacy?.toolsBeforePlanMode) ? legacy.toolsBeforePlanMode.filter((name): name is string => typeof name === "string") : undefined;
				continue;
			}
			if (entry.customType !== STATE_TYPE && entry.customType !== LEGACY_STATE_TYPE) continue;
			const state = entry.data as (Omit<WorkflowState, "version" | "stage"> & { version: number; stage: string }) | undefined;
			if ((state?.version !== 1 && state?.version !== 2) || state.project !== project || state.ownerSessionId !== ownerSessionId) continue;
			stage = state.stage === "off" ? "off" : ["plan", "make", "execute"].includes(state.stage) ? "plan" : "discuss";
			todoItems = copyTodos(state.todos);
			// Keep the preview hidden on startup/reload; progress is restored independently.
		}
		// Older versions hid write/edit. Recover their original loadout once; hooks now enforce scope.
		if (legacyTools?.length) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...legacyTools])]);
		try { reloadPlan(ctx); } catch (error) { notify(ctx, `Cannot restore saved plan: ${String(error)}`, true); }
		updateStatus(ctx);
		if (!savedPlan && stage !== "off") notify(ctx, noSessionPlan(ctx));
	}
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		// Invalidate any suspended command context and revoke authoring before runtime replacement.
		clearStartupWatch();
		generation++; stopping = true; disposed = true;
	});
}
