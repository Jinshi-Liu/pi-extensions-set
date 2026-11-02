import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type BoundaryState } from "@earendil-works/pi-coding-agent";

export interface Child {
 session: string; childId: string; tier?: string; cwd: string; tools: string[];
 model: string; thinkingLevel: ThinkingLevel;
 state: "running" | "completed" | "failed" | "cancelled";
 prompt: string; result?: string; resultFile?: string;
}
interface State { children: Child[]; pending: string[] }

/** One durable mailbox per parent session, independent of the parent's active tool turn. */
export function registerBackground(pi: ExtensionAPI) {
 let state: State = { children: [], pending: [] };
 let directory = "";
 let stopped = false;
 const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
 const persist = () => {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "state.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2));
  fs.renameSync(file + ".tmp", file);
 };
 function initialize(ctx: ExtensionContext) {
  if (directory) return;
  const key = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex");
  directory = path.join(getAgentDir(), "subagent-sessions", "parents", key);
  const file = path.join(directory, "state.json");
  if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const child of state.children) if (child.state === "running") {
   child.state = "cancelled"; child.result = "Interrupted by parent process exit. Resume this session with a new prompt.";
   if (!state.pending.includes(child.session)) state.pending.push(child.session);
  }
  persist();
 }
 function content() {
  return state.pending.map((id) => {
   const c = state.children.find((c) => c.session === id)!;
   return `[Subagent ${c.session}: ${c.state}]\n${c.result ?? ""}${c.resultFile ? `\nFull result: ${c.resultFile}` : ""}`;
  }).join("\n\n");
 }
 function drain() {
  const text = content();
  state.pending = []; persist();
  return text;
 }
 function idleDelivery(ctx: ExtensionContext) {
  if (stopped || !state.pending.length || !ctx.isIdle()) return;
  const text = content();
  pi.sendMessage({ customType: "subagent-results", content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
  state.pending = []; persist();
 }
 function boundary(event: BoundaryState) {
  if (stopped || !state.pending.length || event.outcome !== "completed" || !event.context.canContinue) return;
  return { entries: [...event.entries, { type: "custom_message" as const, customType: "subagent-results", content: drain(), display: true }], continue: true };
 }
 pi.on("session_start", (_event, ctx) => {
  directory = ""; state = { children: [], pending: [] }; stopped = false;
  initialize(ctx);
 });
 pi.on("turn_end", boundary);
 pi.on("agent_before_settle", boundary);
 pi.on("agent_settled", (event, ctx) => { if (!event.aborted) idleDelivery(ctx); });
 pi.on("before_agent_start", () => {
  if (!state.pending.length) return;
  return { message: { customType: "subagent-results", content: drain(), display: true } };
 });
 pi.on("session_shutdown", async () => {
  stopped = true;
  for (const job of active.values()) job.controller.abort();
  await Promise.allSettled([...active.values()].map((job) => job.promise));
 });
 return {
  list(ctx: ExtensionContext) { initialize(ctx); return state.children; },
  get(ctx: ExtensionContext, session: string) { initialize(ctx); return state.children.find((c) => c.session === session); },
  cancel(session: string) { const job = active.get(session); job?.controller.abort(); return !!job; },
  start(ctx: ExtensionContext, child: Child, work: (signal: AbortSignal) => Promise<{ text: string; failed: boolean; details?: unknown }>) {
   initialize(ctx);
   if (stopped) throw new Error("Subagent runtime is shutting down");
   if (active.has(child.session)) throw new Error(`Session ${child.session} is busy. Wait for its completion before continuing it.`);
   // Never overwrite an undelivered completion when reusing a child.
   if (state.pending.includes(child.session)) throw new Error(`Session ${child.session} has an undelivered result; wait for the next notification.`);
   const index = state.children.findIndex((c) => c.session === child.session);
   if (index < 0) state.children.push(child); else state.children[index] = child;
   persist();
   const controller = new AbortController();
   const promise = Promise.resolve().then(async () => {
    try {
     const result = await work(controller.signal);
     child.state = controller.signal.aborted ? "cancelled" : result.failed ? "failed" : "completed";
     child.resultFile = path.join(directory, `${randomUUID()}.json`);
     fs.writeFileSync(child.resultFile, JSON.stringify(result, null, 2));
     child.result = result.text.slice(0, 24000);
     if (result.text.length > 24000) child.result += "\n[truncated; read full result file]";
    } catch (error) {
     child.state = controller.signal.aborted ? "cancelled" : "failed";
     child.result = error instanceof Error ? error.message : String(error);
    } finally {
     active.delete(child.session);
     state.pending.push(child.session);
     persist();
     idleDelivery(ctx);
    }
   }).catch((error) => { ctx.ui.notify(`Subagent mailbox error: ${String(error)}`, "error"); });
   active.set(child.session, { controller, promise });
  },
 };
}
