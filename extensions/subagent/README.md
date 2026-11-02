# Background Subagents

Run `/reload` after updating the extension.

## Commands

- `/subagent`: expand/collapse the live status panel. `/subagent hide` also hides it without cancelling work.
- `/subagent-model`: configure **low / medium / high / max**. Select a tier, then type to search available models by provider, model ID, or display name. Uses Pi's fuzzy matching engine, with Up/Down navigation, Enter to select, and Esc to cancel. Search for `clear tier` to restore the parent-model fallback. Selecting a subagent model never changes the main Agent's model.

Mappings are saved globally in `~/.pi/agent/subagent-models.json`. Unconfigured tiers follow the current parent model. The main Agent receives tier guidance and each selected model's supported thinking levels.

## Tool parameters

| Parameter | Meaning |
|---|---|
| action | `dispatch` (default), `status`, or `cancel` |
| session | Stable English child name such as `reviewer`; omitted to generate a persistent ID |
| prompt | Task instructions, ongoing responsibilities, authorization limits, and expected results; required for dispatch |
| tier | `low`, `medium`, `high`, or `max`; required for a new child, optional when continuing a child with a saved tier |
| thinking | Main Agent chooses from the tier model's supported levels; defaults to its lowest supported level on each call |
| tools | Exact tool allowlist; defaults to the previous child's tools, or the parent's active tools for a new child; `[]` disables all |
| cwd | Working directory; defaults to the previous child's directory, or the parent's directory for a new child |

There are **no `model` or `role` parameters**. Models can only be selected through tiers. Put ongoing responsibilities in the first prompt; later tasks reuse the conversation through `session`.

Session names accept ASCII letters, numbers, dots, underscores, and hyphens, and must start/end with a letter or number. A session is an identity, not the task itself.

Examples:

```json
{"session":"reviewer","tier":"high","thinking":"high","tools":["read","grep","find","ls"],"prompt":"You are the ongoing read-only code reviewer. Review the authentication module and report evidence. Do not change files."}
```

After the completion notification:

```json
{"session":"reviewer","prompt":"Continue reviewing the new tests using your earlier findings."}
```

The follow-up reuses the saved tier but resolves its current configured model, so tier configuration changes take effect on the next dispatch. Specify thinking again when a stronger level is needed. The chosen level must be supported by that model.

```json
{"action":"status","session":"reviewer"}
{"action":"cancel","session":"reviewer"}
```

Omit session with `status` to list all children of the current parent session. Dispatching another task to a busy child is rejected. Parallel tasks need different sessions and disjoint files/browser sessions.

## Background delivery and lifecycle

- Dispatch returns an acknowledgement immediately, not a completed result.
- Completion is saved to a durable mailbox. While the parent is busy, notification is delivered at `turn_end` / `agent_before_settle`, with one continuation request. Running tools are not interrupted.
- If the parent is idle, a Pi follow-up message wakes it. The main Agent should continue independent work or end its turn and wait, rather than poll.
- Cancelling the parent turn does not cancel already accepted background work. Use `action=cancel` explicitly.
- Reload, parent-session switch, and process exit stop children and wait for cleanup. Pending results and interruption state remain available when the original parent session resumes.
- Children do not keep running after parent shutdown; print/JSON one-shot exit also performs cleanup.
- Notification text is capped at 24,000 characters. Full results, details, and usage are saved to the referenced JSON file. Background usage is not retroactively added to the returned dispatch acknowledgement.

## Persistence and compatibility

`~/.pi/agent/subagent-sessions/` stores independent child conversations. `parents/<parent-session-hash>/` stores child configuration, status, pending notifications, and full result files.

Names are isolated by parent session; each child has an internal UUID. Resuming the same parent can continue its children. Old records without a saved tier require an explicit tier on their first follow-up; their internal conversation ID is retained. Legacy role/model fields are no longer dispatch parameters.

Children load installed extensions, skills, and configuration, not the parent's conversation. Recursive delegation is prohibited. Tool allowlists are not an OS sandbox, and cancellation cannot undo completed changes.

## Tests

```powershell
# From the repository root:
node extensions/subagent/tests/verify.mjs
node extensions/subagent/models-test.mjs
```

Set `PI_TEST_INSTALL` to the Pi installation’s `node_modules` directory when using a non-default installation.

Tests use simulated JSON child processes, real TUI input/filter components, and the installed model-capability function; they do not spend model credits. Coverage includes background acknowledgement, boundary/idle notifications, persistent sessions and tiers, cancellation/reload, status toggling, tier-only resolution, model search, cancel/clear/no-match behavior, and narrow terminal widths.
