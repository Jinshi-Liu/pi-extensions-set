import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { INHERIT, selectTierModel } from "./model-picker.ts";

const TIERS = ["low", "medium", "high", "max"] as const;
type Tier = (typeof TIERS)[number];
type Mapping = Partial<Record<Tier, string>>;
const GUIDANCE: Record<Tier, string> = {
	low: "simple lookups, extraction, and small mechanical edits",
	medium: "routine implementation, focused tests, and bounded debugging",
	high: "complex multi-file changes, difficult debugging, and design review",
	max: "exceptionally difficult reasoning, architecture, and high-ambiguity tasks",
};
const modelKey = (model: Model<Api>): string => `${model.provider}/${model.id}`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function parseTier(value: string): Tier {
	if (!TIERS.includes(value as Tier)) throw new Error(`Unknown subagent tier "${value}". Use ${TIERS.join(", ")}.`);
	return value as Tier;
}

function availableModel(ctx: ExtensionContext, value: string): Model<Api> {
	const available = ctx.modelRegistry.getAvailable();
	const exact = available.filter((model) => modelKey(model) === value);
	const matches = exact.length ? exact : available.filter((model) => model.id === value);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`Ambiguous model "${value}". Use ${matches.map(modelKey).join(", ")}.`);
	throw new Error(`Model "${value}" is not available. Configure /subagent-model or choose an available exact provider/id.`);
}

/** Only selects dispatch settings; never changes parent model, tools, limits, or permissions. */
export function registerSubagentModels(pi: ExtensionAPI): {
	describe(ctx: ExtensionContext): string;
	resolve(ctx: ExtensionContext, tier: string, thinking?: string): { model: string; thinkingLevel: ThinkingLevel };
} {
	const file = join(getAgentDir(), "subagent-models.json");

	// Read on demand so other sessions' changes become visible without a reload.
	function load(): Mapping {
		let raw: string;
		try { raw = readFileSync(file, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a tier-to-model object");
			const mapping: Mapping = {};
			for (const [key, value] of Object.entries(parsed)) {
				const tier = parseTier(key);
				if (typeof value !== "string" || !value.trim()) throw new Error(`${tier} must be a nonempty model string`);
				mapping[tier] = value;
			}
			return mapping;
		} catch (error) { throw new Error(`Invalid ${file}: ${errorText(error)}`); }
	}

	function selected(ctx: ExtensionContext, mapping: Mapping, tier: Tier): Model<Api> {
		const value = mapping[tier] ?? (ctx.model ? modelKey(ctx.model) : undefined);
		if (value === undefined) throw new Error("No current parent model. Select a model or configure /subagent-model.");
		return availableModel(ctx, value);
	}

	function describe(ctx: ExtensionContext): string {
		const currentSession = [
			"Current session (you):",
			`model: ${ctx.model ? modelKey(ctx.model) : "unknown"}`,
			`thinking: ${pi.getThinkingLevel()}`,
			"These are your settings, not the subagent tier defaults.",
		].join("\n");
		let mapping: Mapping;
		try { mapping = load(); }
		catch (error) { return `${currentSession}\n\nSubagent model configuration error: ${errorText(error)}`; }
		return [
			currentSession,
			"",
			"Subagent model tiers (configure with /subagent-model):",
			...TIERS.map((tier) => {
				const target = mapping[tier] ?? `current parent model ${ctx.model ? modelKey(ctx.model) : "(none)"} (tier not configured)`;
				try {
					const model = selected(ctx, mapping, tier);
					const levels = getSupportedThinkingLevels(model);
					return `${tier}: ${target}; ${GUIDANCE[tier]}; thinking: ${levels.join(", ") || "none"}; default: ${levels[0] ?? "unavailable"}.`;
				} catch (error) { return `${tier}: ${target}; ${GUIDANCE[tier]}; unavailable: ${errorText(error)}`; }
			}),
			"Select models only through tier (low/medium/high/max), never by model ID. New subagents require a tier; follow-ups may retain their previous tier. Put ongoing responsibilities and tasks in prompt, not a separate role. Choose thinking from the selected tier model supported options; otherwise use its lowest supported level. Unconfigured tiers follow the current parent model. Tiers do not change authorization or tool limits.",
		].join("\n");
	}

	pi.registerCommand("subagent-model", {
		description: "Configure global low/medium/high/max subagent model tiers",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("/subagent-model requires interactive TUI mode.", "error"); return; }
			try {
				for (;;) {
					const mapping = load();
					const labels = TIERS.map((tier) => `${tier}: ${mapping[tier] ?? "current parent model (not configured)"}`);
					const choice = await ctx.ui.select("Subagent model tiers", [...labels, "Done"]);
					if (choice === undefined || choice === "Done") return;
					const index = labels.indexOf(choice);
					if (index < 0) return;
					const tier = TIERS[index];
					const picked = await selectTierModel(ctx, tier, mapping[tier]);
					if (picked === undefined) continue;
					const value = picked === INHERIT ? undefined : modelKey(availableModel(ctx, picked));
					await withFileMutationQueue(file, async () => {
						const next = load();
						if (value === undefined) delete next[tier];
						else next[tier] = value;
						mkdirSync(dirname(file), { recursive: true });
						const temporary = `${file}.${randomUUID()}.tmp`;
						try {
							writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
							renameSync(temporary, file);
						} finally { rmSync(temporary, { force: true }); }
					});
					ctx.ui.notify(`${tier}: ${value ?? "current parent model (not configured)"}`, "info");
				}
			} catch (error) { ctx.ui.notify(errorText(error), "error"); }
		},
	});

	return {
		describe,
		resolve(ctx, tier, thinking) {
			const validTier = parseTier(tier);
			const chosen = selected(ctx, load(), validTier);
			const levels = getSupportedThinkingLevels(chosen);
			const level = thinking === undefined ? (levels.includes("off") ? "off" : levels[0]) : levels.find((value) => value === thinking);
			if (level === undefined) throw new Error(`Unsupported thinking "${thinking ?? "default"}" for ${modelKey(chosen)}. Supported: ${levels.join(", ") || "none"}.`);
			return { model: modelKey(chosen), thinkingLevel: level };
		},
	};
}
