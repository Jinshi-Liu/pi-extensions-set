# Plan Mode: Discuss → Make → Discuss → Execute

A discussion-first planning workflow. Run `/reload` after updating the extension.

## Commands

| Command | Behavior |
| --- | --- |
| `/plan` | Toggle planning on/off. No prompt argument. Turning planning off does not execute the plan. |
| `/plan make` | Explicitly authorize one drafting/revision run for `.pi/plan.md`, then return to discussion. |
| `/plan execute` | Explicitly execute the saved plan. |
| `/plan steer` | Stop execution and return to discussion, keeping the plan and tracked progress. |
| `/plan off` | Explicitly stop safely and turn the workflow off. |
| `/plan status` | Show the current stage and plan location. |
| `/plan help` | Show command usage. |
| `/todos` | Toggle the compact progress panel. |
| `/todos show` / `/todos hide` | Explicitly show/hide the panel without affecting execution. |
| `/todos all` | Open the full scrollable task list. |
| `/todos help` | Show todo command usage. |

Type `/plan ` or `/todos ` to see argument suggestions. `Ctrl+Alt+P` also toggles planning. The `--plan` startup flag opens discussion mode.

## 1. Discuss

Start with `/plan`, then describe your problem in a normal message.

The assistant should:

- Use **questionnaire** for questions, preferences, and confirmation of the final goal.
- Challenge vague goals, hidden assumptions, conflicting requirements, and unnecessary scope, without turning the conversation into an interrogation.
- Ask focused questions progressively, adapting to previous answers rather than delivering a large generic questionnaire.
- Inspect the code and relevant documentation, and research comparable implementations before asking questions it can answer itself.
- Clarify goals, non-goals, constraints, tradeoffs, acceptance criteria, and unresolved decisions.
- Explain alternatives and its recommended solution so the user can understand and challenge the reasoning.
- Avoid prematurely producing a formal plan or changing project files.

A questionnaire answer such as “yes”, or a chat request to execute, **does not grant a stage change**. The assistant may recommend the next command, but only the user can explicitly authorize it.

## 2. Make

Run `/plan make` when ready to create or revise the plan.

This authorizes one run to write, replace, or substantially redesign **only** the project's `.pi/plan.md`. Implementation changes remain unavailable. Existing plans should be read and reconciled with current code and completed work rather than blindly repeated.

The formal plan is written in English and should capture the agreed goal, constraints, evidence, alternatives, rationale, actionable steps, verification, and open questions. Trackable steps use this format:

```markdown
## Plan:
1. Implement the first agreed change.
   Include relevant details and acceptance criteria.
2. Verify the change against the agreed requirements.
```

When drafting finishes, the assistant returns to discussion. Use `/plan make` again to revise, or `/plan execute` to implement. There is no automatic execution-choice dialog.

## 3. Execute and steer

`/plan execute` reads the saved plan and begins execution. `[DONE:n]` markers track completed steps.

Use `/plan steer` when the direction needs to change. It aborts the active operation and returns to discussion without deleting the plan or progress. Work already performed is not rolled back. Discuss the new situation, use `/plan make` to revise the document, then `/plan execute` to resume.

Unchanged task descriptions retain tracked completion across revisions; changed or new tasks need fresh verification. Progress belongs to the session branch, while the plan document is a project file shared across sessions. A reload/resume must not silently renew a drafting grant or start execution.

## Todo display

The compact panel shows up to five tasks, adapts to terminal height, and follows the first unfinished step. It starts hidden after startup/reload.

`/todos all` shows full wrapped descriptions. Navigate with Up/Down, PageUp/PageDown, and Home/End; close with Esc, Ctrl+C, or `q`. Fullscreen mode also supports the mouse wheel. Opening the full viewer does not change compact-panel visibility.

Only preview lines are truncated; stored descriptions are not. Existing tasks are not automatically translated, and text truncated by older versions cannot be recovered without revising the plan.

## Language and boundaries

Extension UI and formal plans use English. Discussion and questionnaire text can follow the user's language.

Discuss and Make restrict mutation tools; Make only grants plan-document editing. Tools may remain listed, but direct and nested calls are checked before execution. Research remains available through read-only tools. Delegation is blocked while the workflow is active because child agents do not share its scoped permissions. These extension checks are workflow guardrails, not an operating-system sandbox. Explicitly turning planning off restores normal tool access.

If the saved plan changes or disappears during execution, execution is stopped for review. This avoids continuing against a silently changed plan.

## Tests

Run from this directory:

```text
node todos-test.mjs
node workflow-test.mjs
```

Tests use the installed Pi 1.4.0 dependencies. Set `PI_TEST_INSTALL` to another installation's `node_modules` directory if needed. Workflow tests use temporary project directories, never a real project plan.
