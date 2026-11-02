/** Explicit discussion -> one-run plan authoring -> authorized execution workflow. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { createTodoWidget, TodoListView } from "./todos-ui.ts";
import { markCompletedSteps, type TodoItem } from "./utils.ts";
import {
	STATE_TYPE, PLAN_USAGE, TODOS_USAGE, PLAN_ACTIONS, TODO_ACTIONS,
	completions, isDelegationTool, isPlanPath, isResearchCommand, isResearchTool,
	isScopedPlanPath, planPath, projectKey, readPlan, stageGuidance,
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

export default function planModeExtension(pi: ExtensionAPI): void {
	let stage: Stage = "off";
	let todoItems: TodoItem[] = [];
	let todosVisible = false;
	let savedPlan: SavedPlan | undefined;
	let project = "";
	let stopping = false;
	let commandStopping = false;
	let trackStoppedExecution = false;
	let makeGrant: string | undefined;
	let makeStarted = false;
	let generation = 0;
	let startupWatch: ReturnType<typeof setTimeout> | undefined;
	function clearStartupWatch(): void {
		if (startupWatch) clearTimeout(startupWatch);
		startupWatch = undefined;
	}
	// sendMessage is fire-and-forget. Preparation failures return to idle without
	// agent_settled, so watch only the interval before agent_start takes ownership.
	function watchStartup(ctx: ExtensionContext, expected: "make" | "execute"): void {
		clearStartupWatch();
		const epoch = generation;
		const check = () => {
			startupWatch = undefined;
			if (epoch !== generation || stage !== expected || stopping) return;
			if (ctx.isIdle()) {
				stage = "discuss";
				revokeMake();
				publish(ctx);
				notify(ctx, "The requested run did not start. Discussion mode restored; use /plan make or /plan execute to retry.", true);
				return;
			}
			startupWatch = setTimeout(check, 50);
			startupWatch.unref();
		};
		startupWatch = setTimeout(check, 50);
		startupWatch.unref();
	}

	pi.registerFlag("plan", { description: "Start in read-only design discussion", type: "boolean", default: false });

	function persistState(): void {
		pi.appendEntry<WorkflowState>(STATE_TYPE, {
			version: 1, project,
			// Authoring grants are deliberately never durable. Execute is restored as discuss too.
			stage: stage === "make" ? "discuss" : stage,
			todos: todoItems.map((item) => ({ ...item })),
			planHash: savedPlan?.hash, todosVisible,
		});
	}
	function updateStatus(ctx: ExtensionContext): void {
		const completed = todoItems.filter((item) => item.completed).length;
		const label = stopping ? "plan: stopping" : stage === "off" ? undefined :
			`plan: ${stage}${todoItems.length ? ` ${completed}/${todoItems.length}` : ""}`;
		ctx.ui.setStatus("plan-mode", label ? ctx.ui.theme.fg(stage === "execute" ? "accent" : "warning", label) : undefined);
		ctx.ui.setWidget("plan-todos", todosVisible && todoItems.length ?
			(tui, theme) => createTodoWidget(() => todoItems, tui, theme) : undefined);
	}
	function publish(ctx: ExtensionContext): void { updateStatus(ctx); persistState(); }
	function notify(ctx: ExtensionContext, message: string, error = false): void {
		ctx.ui.notify(message, error ? "error" : "info");
	}
	function adoptPlan(plan: SavedPlan | undefined): void {
		savedPlan = plan;
		// Keep historical progress if the file is missing/temporarily malformed. Never execute it.
		if (plan?.todos.length) todoItems = plan.todos;
	}
	function reloadPlan(ctx: ExtensionContext): SavedPlan | undefined {
		const plan = readPlan(ctx.cwd, todoItems);
		if (plan?.todos.length) {
			const removed = todoItems.filter((item) => item.completed).length - plan.todos.filter((item) => item.completed).length;
			if (removed > 0) notify(ctx, `${removed} previously completed task description(s) changed or were removed. Unchanged tasks retain progress; revised tasks need verification before being marked complete.`);
		}
		adoptPlan(plan);
		return plan;
	}
	function revokeMake(): void { makeGrant = undefined; makeStarted = false; }

	/** Lock first, abort second, unlock only after the command-only idle barrier. */
	async function stop(ctx: ExtensionCommandContext, target: "off" | "discuss"): Promise<void> {
		if (stopping) { notify(ctx, "A safe stop is already in progress."); return; }
		const epoch = generation;
		clearStartupWatch();
		commandStopping = true;
		stopping = true;
		trackStoppedExecution = stage === "execute";
		stage = "discuss";
		revokeMake();
		publish(ctx);
		try {
			ctx.abort();
			await ctx.waitForIdle();
			if (epoch !== generation) return;
			// Reconcile any completed plan edit before cancellation, but never write the plan here.
			try { reloadPlan(ctx); } catch (error) { notify(ctx, `Cannot reload saved plan: ${String(error)}`, true); }
			stage = target;
			stopping = false;
			commandStopping = false;
			trackStoppedExecution = false;
			publish(ctx);
			notify(ctx, target === "off" ? "Plan workflow off. Normal tool access restored." :
				"Discussion mode. Saved plan and completed progress retained. Use /plan make after redesign.");
		} catch (error) {
			if (epoch !== generation) return;
			// Fail closed if the runtime cannot confirm settlement. agent_settled can release this lock.
			commandStopping = false;
			notify(ctx, `Stop could not confirm idle; tool access remains locked: ${String(error)}`, true);
		}
	}
	function idleForGrant(ctx: ExtensionContext): boolean {
		if (stopping || !ctx.isIdle() || ctx.hasPendingMessages()) {
			notify(ctx, "This command requires an idle agent with no queued messages. Use /plan steer to stop first.");
			return false;
		}
		return true;
	}
	function startMake(ctx: ExtensionCommandContext): void {
		if (!idleForGrant(ctx)) return;
		try { reloadPlan(ctx); }
		catch (error) { stage = "discuss"; revokeMake(); publish(ctx); notify(ctx, `Cannot open project plan: ${String(error)}`, true); return; }
		stage = "make";
		makeGrant = `make-${generation}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		makeStarted = false;
		publish(ctx);
		watchStartup(ctx, "make");
		try {
			pi.sendMessage({
				customType: "plan-workflow-make", display: true, details: { grant: makeGrant },
				content: "Create or revise the English project plan in .pi/plan.md from the discussion. This authorizes plan-file changes for this run only, not implementation. Preserve unchanged task wording and completed progress. Then return to discussion; show /plan execute and /plan make.",
			}, { triggerTurn: true });
		} catch (error) {
			stage = "discuss"; revokeMake(); publish(ctx);
			notify(ctx, `Could not start plan authoring: ${String(error)}`, true);
		}
	}
	function startExecute(ctx: ExtensionCommandContext): void {
		if (!idleForGrant(ctx)) return;
		const oldHash = savedPlan?.hash;
		let plan: SavedPlan | undefined;
		try { plan = reloadPlan(ctx); }
		catch (error) { stage = "discuss"; revokeMake(); publish(ctx); notify(ctx, `Cannot open saved plan: ${String(error)}`, true); return; }
		if (!plan?.todos.length) {
			stage = "discuss";
			notify(ctx, "No executable saved plan. Use /plan make to write .pi/plan.md with a 'Plan:' numbered task list.");
			publish(ctx); return;
		}
		if (oldHash && oldHash !== plan.hash) notify(ctx, "Saved plan changed; reloaded it and retained completion for unchanged task text.");
		if (todoItems.every((item) => item.completed)) {
			stage = "discuss";
			notify(ctx, "All saved steps are already complete. Use /plan make to revise the plan.");
			publish(ctx); return;
		}
		stage = "execute";
		revokeMake();
		publish(ctx);
		watchStartup(ctx, "execute");
		try {
			pi.sendMessage({ customType: "plan-workflow-execute", display: true,
				content: "Execute the saved .pi/plan.md plan, continuing only unfinished steps. Verify each step and report [DONE:n]. Do not change the plan file. If redesign is needed, suggest /plan steer, then /plan make." },
				{ triggerTurn: true });
		} catch (error) {
			stage = "discuss"; publish(ctx);
			notify(ctx, `Could not start execution: ${String(error)}`, true);
		}
	}

	pi.registerCommand("plan", {
		description: "Toggle off/discuss; explicitly make, execute, or steer the saved project plan",
		getArgumentCompletions: (prefix) => completions(PLAN_ACTIONS, prefix),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "help") {
				notify(ctx, `${PLAN_USAGE}\nDiscuss read-only; clarification uses questionnaire. /plan make grants one plan-file-only authoring run. /plan execute runs the saved plan. /plan steer aborts safely for redesign, retaining progress. Chat approval never changes stages.`);
			} else if (action === "status") {
				let description = "not found";
				try {
					const current = readPlan(ctx.cwd, todoItems);
					description = current ? `${current.todos.length} steps${savedPlan && current.hash !== savedPlan.hash ? " (changed on disk; reload at /plan execute)" : ""}` : "not found";
				} catch (error) { description = String(error); }
				notify(ctx, `Stage: ${stopping ? "stopping" : stage}\nPlan: ${planPath(ctx.cwd)} — ${description}\nSession progress: ${todoItems.filter((item) => item.completed).length}/${todoItems.length} complete`);
			} else if (action === "make") startMake(ctx);
			else if (action === "execute") startExecute(ctx);
			else if (action === "steer") await stop(ctx, "discuss");
			else if (action === "off") await stop(ctx, "off");
			else if (action === "") await stop(ctx, stage === "off" ? "discuss" : "off");
			else notify(ctx, PLAN_USAGE);
		},
	});

	pi.registerCommand("todos", {
		description: "Toggle the compact task panel; all opens the full scrollable list",
		getArgumentCompletions: (prefix) => completions(TODO_ACTIONS, prefix),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!["", "all", "show", "hide", "help"].includes(action)) { notify(ctx, TODOS_USAGE); return; }
			if (action === "help") { notify(ctx, `${TODOS_USAGE} /todos toggles the compact panel; all opens the full list.`); return; }
			if (action === "hide") { todosVisible = false; publish(ctx); return; }
			if (!stopping && stage !== "execute" && stage !== "make") {
				try { reloadPlan(ctx); }
				catch (error) { notify(ctx, `Cannot reload saved todos: ${String(error)}`, true); }
			}
			if (todoItems.length === 0) { notify(ctx, "No todos. Create a saved plan with /plan make."); return; }
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
		description: "Toggle off/discuss (idle only; use /plan steer while busy)",
		handler: async (ctx) => {
			if (!idleForGrant(ctx)) return;
			stage = stage === "off" ? "discuss" : "off";
			revokeMake(); publish(ctx);
			notify(ctx, stage === "off" ? "Plan workflow off." : "Discussion mode (read-only). Use /plan make when ready.");
		},
	});

	function invalidateExecution(ctx: ExtensionContext, reason: string): void {
		stage = "discuss";
		stopping = true;
		trackStoppedExecution = false;
		publish(ctx);
		ctx.abort();
		notify(ctx, `${reason} Execution stopped; progress retained. Review in discussion, then use /plan make or /plan execute.`, true);
	}
	function checkSnapshot(ctx: ExtensionContext): boolean {
		if (stage !== "execute") return true;
		try {
			const current = readPlan(ctx.cwd, todoItems);
			if (!current || current.hash !== savedPlan?.hash) {
				invalidateExecution(ctx, "The saved plan changed or disappeared on disk."); return false;
			}
		} catch (error) { invalidateExecution(ctx, `Cannot verify the saved plan: ${String(error)}`); return false; }
		return true;
	}

	// Nested calls (including codemode) pass through the same hook. Never trust the outer call alone.
	pi.on("tool_call", (event, ctx) => {
		const block = (reason: string) => ({ block: true, reason });
		if (stopping) return block("Plan workflow is stopping. All further tool calls are blocked until abort settles.");
		if (stage === "off") return;
		if (!checkSnapshot(ctx)) return block("Plan snapshot changed. Execution authorization revoked.");
		const name = event.toolName;
		const input = event.input as Record<string, unknown>;
		if (name === "write" || name === "edit") {
			if (stage === "make" && makeStarted && isScopedPlanPath(ctx.cwd, input.path)) return;
			if (stage === "execute" && !isPlanPath(ctx.cwd, input.path)) return;
			return block(stage === "execute" ? "The plan file is protected during execution. Use /plan steer, then /plan make for redesign." :
				"Read-only discussion; /plan make grants one run of write/edit access ONLY to project .pi/plan.md.");
		}
		if (isDelegationTool(name)) return block("Delegation cannot enforce this workflow's file permissions. Inspect and act with local guarded tools instead.");
		if (stage === "execute") {
			// Direct write/edit targets are checked above. Catch explicit shell and custom-tool plan targets too.
			if (name === "bash" || name === "powershell") {
				const command = String(input.command ?? "");
				if (/plan\.md|(?:^|[\s/'"\\])\.pi(?:[\s/'"\\]|$)/i.test(command))
					return block("Shell access to the plan path is protected during execution. Use read to inspect it; /plan steer then /plan make to revise it.");
			}
			for (const key of ["path", "file", "filePath", "destination", "target"]) {
				if (typeof input[key] === "string" && isPlanPath(ctx.cwd, input[key]) && !isResearchTool(name, pi.getAllTools().find((tool) => tool.name === name)))
					return block("The saved plan is protected. Use /plan steer, then /plan make to revise it.");
			}
			return;
		}
		if (name === "bash") return isResearchCommand(input.command) ? undefined : block("Discussion/authoring allows only simple read-only shell inspection. Use read/grep/find/ls and available web research tools; no shell changes or delegation.");
		if (!isResearchTool(name, pi.getAllTools().find((tool) => tool.name === name)))
			return block(`Tool '${name}' is not a read-only research tool. ${stage === "make" ? "Only write/edit of .pi/plan.md is authorized." : "Discuss first; /plan make authors a plan and /plan execute authorizes implementation."}`);
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => {
			const custom = message as AgentMessage & { customType?: string; details?: { grant?: string } };
			const type = custom.customType;
			if (type === "plan-workflow-make") return stage === "make" && custom.details?.grant === makeGrant;
			if (type === "plan-workflow-execute") return stage === "execute";
			return !type || !["plan-mode-context", "plan-execution-context", "plan-workflow-context", "plan-mode-execute"].includes(type);
		}),
	}));
	pi.on("before_agent_start", (event, ctx) => {
		if (stage === "make") {
			const grant = event.messageType === "custom" && event.message.customType === "plan-workflow-make" ?
				(event.message.details as { grant?: string } | undefined)?.grant : undefined;
			if (!makeStarted && grant === makeGrant && grant !== undefined) makeStarted = true;
			else {
				// A different new prompt cannot inherit a pending/previous authoring grant.
				stage = "discuss"; revokeMake(); publish(ctx);
			}
		}
		checkSnapshot(ctx);
		const guidance = stopping ? "Plan workflow is stopping. Do not call tools or continue implementation." : stageGuidance(stage, todoItems, savedPlan);
		if (guidance) event.systemPromptOptions.sections.plan_workflow = guidance;
		else delete event.systemPromptOptions.sections.plan_workflow;
	});

	pi.on("turn_end", (event, ctx) => {
		if ((stage !== "execute" && !trackStoppedExecution) || !isAssistantMessage(event.message)) return;
		if (stage === "execute" && !checkSnapshot(ctx)) return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) publish(ctx);
	});
	pi.on("agent_start", () => clearStartupWatch());
	pi.on("agent_settled", (_event, ctx) => {
		clearStartupWatch();
		if (commandStopping) return; // The command owns its waitForIdle barrier.
		if (stopping) {
			stopping = false; trackStoppedExecution = false;
			publish(ctx); return;
		}
		if (stage === "make") {
			stage = "discuss"; revokeMake();
			try {
				const plan = reloadPlan(ctx);
				notify(ctx, plan?.todos.length ? "Plan authoring ended. Use /plan execute to run the saved plan or /plan make to revise it." :
					"Plan authoring ended without a valid saved task list. Use /plan make to create or repair .pi/plan.md, then /plan execute.");
			} catch (error) { notify(ctx, `Plan authoring ended. Cannot read saved plan: ${String(error)}. Use /plan make to retry.`, true); }
			publish(ctx);
		} else if (stage === "execute" && todoItems.length && todoItems.every((item) => item.completed)) {
			stage = "discuss"; publish(ctx);
			notify(ctx, "Plan complete. Progress and saved plan retained; discussion mode restored. Use /plan make for further changes.");
		}
	});

	function restore(ctx: ExtensionContext): void {
		clearStartupWatch();
		generation++;
		stopping = false; commandStopping = false; trackStoppedExecution = false;
		revokeMake(); savedPlan = undefined; todoItems = []; todosVisible = false;
		project = projectKey(ctx.cwd);
		stage = pi.getFlag("plan") === true ? "discuss" : "off";
		// Only the active ancestry counts; abandoned branch entries must not leak progress or grants.
		let restoredWorkflow = false;
		let legacyTools: string[] | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "plan-mode" && !restoredWorkflow) {
				const legacy = entry.data as { enabled?: boolean; executing?: boolean; todos?: unknown; toolsBeforePlanMode?: unknown } | undefined;
				stage = legacy?.enabled || legacy?.executing ? "discuss" : "off";
				todoItems = copyTodos(legacy?.todos);
				legacyTools = Array.isArray(legacy?.toolsBeforePlanMode) ? legacy.toolsBeforePlanMode.filter((name): name is string => typeof name === "string") : undefined;
				continue;
			}
			if (entry.customType !== STATE_TYPE) continue;
			const state = entry.data as WorkflowState | undefined;
			if (state?.version !== 1 || state.project !== project) continue;
			restoredWorkflow = true; legacyTools = undefined;
			stage = state.stage === "off" ? "off" : "discuss";
			todoItems = copyTodos(state.todos);
			// Keep the preview hidden on startup/reload; progress is restored independently.
		}
		// Older versions hid write/edit. Recover their original loadout once; hooks now enforce scope.
		if (legacyTools?.length) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...legacyTools])]);
		try { reloadPlan(ctx); } catch (error) { notify(ctx, `Cannot restore saved plan: ${String(error)}`, true); }
		updateStatus(ctx);
	}
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		// Invalidate any suspended command context and revoke authoring before runtime replacement.
		clearStartupWatch();
		generation++; stopping = true; revokeMake();
	});
}
