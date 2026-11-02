import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	ScrollView,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { TodoItem } from "./utils.ts";

function formatTodo(item: TodoItem, theme: Theme): string {
	const label = `${item.step}. ${item.text}`;
	return item.completed
		? theme.fg("success", "[x] ") + theme.fg("muted", theme.strikethrough(label))
		: theme.fg("accent", "[ ] ") + label;
}

function summary(items: TodoItem[]): string {
	return `Todos: ${items.filter((item) => item.completed).length}/${items.length} completed`;
}

/** A small, non-interactive preview that follows the first unfinished step. */
export function createTodoWidget(getItems: () => TodoItem[], tui: TUI, theme: Theme): Component {
	return {
		render(width) {
			const items = getItems();
			if (items.length === 0) return [];
			const count = Math.max(1, Math.min(5, Math.floor(tui.terminal.rows / 3) - 2));
			const firstPending = items.findIndex((item) => !item.completed);
			const start = Math.min(firstPending < 0 ? items.length - 1 : firstPending, Math.max(0, items.length - count));
			const end = Math.min(items.length, start + count);
			return [
				theme.fg("accent", `${summary(items)} | Steps ${start + 1}-${end}`),
				...items.slice(start, end).map((item) => formatTodo(item, theme)),
				theme.fg("dim", "/todos all: full list | /todos: hide"),
			].map((line) => truncateToWidth(line, Math.max(1, width)));
		},
		invalidate() {},
	};
}

/** A bounded, wrapped viewport, including in regular (non-fullscreen) terminals. */
export class TodoListView implements Component {
	private readonly scroll: ScrollView;

	constructor(
		private readonly getItems: () => TodoItem[],
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
	) {
		this.scroll = new ScrollView({
			render: (width) =>
				this.getItems().flatMap((item) => wrapTextWithAnsi(formatTodo(item, this.theme), Math.max(1, width))),
			invalidate() {},
		});
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
		const bodyHeight = Math.max(1, height - 2);
		const lines = this.scroll.render(width);
		// A custom overlay is a leaf component, so bound ScrollView explicitly instead
		// of relying on the fullscreen layout engine to allocate its viewport.
		this.scroll.updateLayout(lines.length, bodyHeight, () => this.tui.requestRender());
		const top = this.scroll.scrollTop;
		const body = lines.slice(top, top + bodyHeight);
		if (height < 3) return body;
		return [
			this.theme.fg("accent", summary(this.getItems())),
			...body,
			this.theme.fg(
				"dim",
				`Lines ${lines.length ? top + 1 : 0}-${Math.min(top + bodyHeight, lines.length)}/${lines.length} | Up/Down, PgUp/PgDn, Home/End | Esc: close`,
			),
		].map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
		else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "wheel") return;
		this.scroll.scrollBy(event.wheelDelta ?? 0);
		return { handled: true, render: true };
	}

	invalidate(): void {
		this.scroll.invalidate();
	}
}
