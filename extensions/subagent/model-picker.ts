import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

export const INHERIT = "Use current parent model (clear tier)";

/** Same fuzzy matching engine and provider/id/name search ordering as /model. */
export function createModelPicker(
 models: Model<Api>[], current: string | undefined, title: string,
 tui: Pick<TUI, "requestRender">, theme: ExtensionContext["ui"]["theme"],
 keys: Pick<KeybindingsManager, "matches">, done: (value: string | undefined) => void,
) {
 const input = new Input();
 const items = [
  { value: INHERIT, label: INHERIT, description: "", search: INHERIT },
  ...[...models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)).map((model) => ({
   value: `${model.provider}/${model.id}`,
   label: `${model.provider}/${model.id}`,
   description: model.name ?? model.id,
   search: `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id} ${model.name ?? ""}`,
  })),
 ];
 const listTheme = {
  selectedPrefix: (s: string) => theme.fg("accent", s), selectedText: (s: string) => theme.fg("accent", s),
  description: (s: string) => theme.fg("muted", s), scrollInfo: (s: string) => theme.fg("dim", s),
  noMatch: (s: string) => theme.fg("warning", s),
 };
 let list: SelectList;
 function filter() {
  const query = input.getValue();
  const filtered = query ? fuzzyFilter(items, query, (item) => item.search) : items;
  list = new SelectList(filtered, 10, listTheme);
  if (!query) list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.value === current)));
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done(undefined);
 }
 filter();
 return {
  get focused() { return input.focused; },
  set focused(value: boolean) { input.focused = value; },
  render(width: number) {
   return [theme.fg("accent", title), theme.fg("muted", `Current: ${current ?? INHERIT}`),
    "", ...input.render(width), "", ...list.render(width), "",
    theme.fg("dim", "Type to search models/providers · Up/Down navigate · Enter select · Esc cancel"),
   ].map((line) => truncateToWidth(line, width));
  },
  invalidate() { input.invalidate(); list.invalidate(); },
  handleInput(data: string) {
   if (keys.matches(data, "tui.select.cancel")) { done(undefined); return; }
   if (["tui.select.up", "tui.select.down", "tui.select.confirm"].some((key) => keys.matches(data, key))) list.handleInput(data);
   else { input.handleInput(data); filter(); }
   tui.requestRender();
  },
 };
}

export async function selectTierModel(ctx: ExtensionContext, tier: string, current?: string): Promise<string | undefined> {
 if (ctx.mode !== "tui") throw new Error("Model search requires interactive TUI mode.");
 return ctx.ui.custom<string | undefined>((tui, theme, keys, done) =>
  createModelPicker(ctx.modelRegistry.getAvailable(), current, `Subagent model: ${tier}`, tui, theme, keys, done));
}
