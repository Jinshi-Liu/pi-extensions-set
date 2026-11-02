import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "codex-usage";
const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;

type UsageWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
};

type UsageResponse = {
	rate_limit?: {
		primary_window?: UsageWindow | null;
		secondary_window?: UsageWindow | null;
	};
};

function accountIdFromToken(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		const auth = payload["https://api.openai.com/auth"];
		return auth?.chatgpt_account_id ?? payload.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function remaining(window: UsageWindow | null | undefined): number | undefined {
	if (typeof window?.used_percent !== "number") return undefined;
	return Math.max(0, Math.min(100, Math.round(100 - window.used_percent)));
}

function resetTime(window: UsageWindow | null | undefined, includeDate: boolean): string | undefined {
	const timestamp =
		typeof window?.reset_at === "number"
			? window.reset_at * 1000
			: typeof window?.reset_after_seconds === "number"
				? Date.now() + window.reset_after_seconds * 1000
				: undefined;
	if (timestamp === undefined) return undefined;

	const date = new Date(timestamp);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	return includeDate ? `${date.getMonth() + 1}/${date.getDate()} ${time}` : time;
}

function formatStatus(ctx: ExtensionContext, usage: UsageResponse): string | undefined {
	const primary = usage.rate_limit?.primary_window;
	const secondary = usage.rate_limit?.secondary_window;
	const fiveHour = remaining(primary);
	const weekly = remaining(secondary);
	if (fiveHour === undefined && weekly === undefined) return undefined;

	const values = [fiveHour, weekly].filter((value): value is number => value !== undefined);
	const lowest = Math.min(...values);
	const color = lowest <= 10 ? "error" : lowest <= 25 ? "warning" : "success";
	const fiveHourReset = resetTime(primary, false);
	const weeklyReset = resetTime(secondary, true);
	const parts = [
		fiveHour === undefined ? undefined : `5h: ${fiveHour}%${fiveHourReset ? `(${fiveHourReset})` : ""}`,
		weekly === undefined ? undefined : `weekly: ${weekly}%${weeklyReset ? `(${weeklyReset})` : ""}`,
	].filter(Boolean);

	return ctx.ui.theme.fg(color, parts.join(" . "));
}

export default function (pi: ExtensionAPI) {
	let requestController: AbortController | undefined;
	let requestGeneration = 0;

	const clear = (ctx: ExtensionContext) => {
		requestGeneration++;
		requestController?.abort();
		requestController = undefined;
		ctx.ui.setStatus(STATUS_ID, undefined);
	};

	const refresh = async (ctx: ExtensionContext, notifyOnError = false) => {
		if (ctx.model?.provider !== PROVIDER_ID) {
			clear(ctx);
			return;
		}

		const generation = ++requestGeneration;
		requestController?.abort();
		const controller = new AbortController();
		requestController = controller;
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", "Codex 用量查询中…"));

		try {
			// Resolving provider auth also refreshes an expired OAuth token.
			const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
			const token = auth?.auth.apiKey;
			if (!token) throw new Error("未找到 Codex OAuth 登录信息");

			const headers: Record<string, string> = {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			};
			const accountId = accountIdFromToken(token);
			if (accountId) headers["ChatGPT-Account-Id"] = accountId;

			const response = await fetch(USAGE_URL, { headers, signal: controller.signal });
			if (!response.ok) throw new Error(`查询失败（HTTP ${response.status}）`);
			const usage = (await response.json()) as UsageResponse;
			const status = formatStatus(ctx, usage);
			if (!status) throw new Error("返回数据中没有用量窗口");

			if (generation === requestGeneration && ctx.model?.provider === PROVIDER_ID) {
				ctx.ui.setStatus(STATUS_ID, status);
			}
		} catch (error) {
			if (generation !== requestGeneration || controller.signal.aborted) return;
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "Codex 用量暂不可用"));
			if (notifyOnError) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		} finally {
			clearTimeout(timeout);
			if (requestController === controller) requestController = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		void refresh(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		void refresh(ctx);
	});

	// Refresh once after the complete task (including all model/tool turns) settles.
	pi.on("agent_settled", (_event, ctx) => {
		void refresh(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clear(ctx);
	});

	pi.registerCommand("codex-usage", {
		description: "刷新 Codex 5 小时和每周剩余用量",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== PROVIDER_ID) {
				ctx.ui.notify("当前模型不是 Codex 账号模型", "warning");
				return;
			}
			await refresh(ctx, true);
		},
	});
}
