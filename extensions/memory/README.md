# Memory

An explicit, minimal memory switch for Pi. `/memory` enables memory context; run it again to disable it. The status bar shows `Memory: ON` or `Memory: OFF` in the theme's dim color.

## Design philosophy

Memory should help when it is relevant, without turning every conversation into a retrieval or bookkeeping task.

- **Opt in, not always on.** New sessions, resumed sessions, and extension reloads start OFF. The switch is not persisted.
- **Index first, details on demand.** When ON, the extension injects the current `index.md` contents at the start of each agent run. The agent can then read only relevant linked files using its existing tools. There is no mandatory retrieval or save step.
- **One global folder.** Memory is not restricted to a personal profile or tied to a project. Keep useful, durable context in one flat Markdown collection.
- **Separate data from maintenance guidance.** The index stays short. Maintenance rules live beside the extension and are referenced by path, not automatically loaded into context.
- **No extra machinery.** No memory tools, database, embeddings, background summarization, automatic extraction, or automatic index generation.

## Installation

Memory is included in this repository's Pi package:

```sh
pi install git:github.com/Jinshi-Liu/pi-extensions-set
```

For an existing installation:

```sh
pi update git:github.com/Jinshi-Liu/pi-extensions-set
```

Then run `/reload` in Pi. Use `pi config` to select extensions from the collection.

For a manual installation, copy this entire directory to `~/.pi/agent/extensions/memory/`. Keep `index.ts` and `memory-rules.md` together. Do not also load an older standalone `memory.ts` or a second installed copy: both would register `/memory`.

## Memory layout

Create the global folder and an initial index yourself, or explicitly ask the agent to create them when writing is permitted:

```text
~/.pi/agent/memory/
├── index.md
├── preferences.md
└── environment.md
```

The filenames above are examples, not pre-created files. A starting index can be as small as:

```markdown
# Memory Index

No entries yet.
```

Once files exist, use short relative links and one-line summaries:

```markdown
# Memory Index

- [Preferences](preferences.md) — Stable working preferences.
- [Environment](environment.md) — Verified machine and development environment details.
```

All memory files belong directly in this folder. No subfolders, nested indexes, or separate project stores. Avoid excessive entries and long summaries; merge related facts into topic files instead of creating a file for every fact. See [maintenance rules](memory-rules.md).

The repository distributes the extension and rules, **not your actual index or memory files**. Installing or updating the package does not overwrite your memory collection. Toggling the extension does not create it.

## What reaches the model

When OFF, the extension contributes no memory prompt and does not read the index.

When ON, it contributes one structured prompt section:

```text
Memory index: <absolute path to ~/.pi/agent/memory/index.md>
Before modifying memory, read: <absolute path to this extension's memory-rules.md>

<current index.md contents>
```

The whole index is injected without truncation, so keep it compact. Linked files and maintenance rules are not automatically read. Missing or unreadable indexes produce a short availability message; an empty index is valid. There is no automatic directory creation.

The index is refreshed at the next agent-run start, not after every tool call. Edits made during a run are therefore reflected in automatic context on the next run. The section is replaced rather than repeatedly appended as chat messages; Pi manages prompt-state changes in its transcript.

## Permissions and boundaries

This is a **context switch**, not a filesystem permission system. OFF removes the extension's current prompt contribution; it does not block tools from accessing files, prohibit an explicit user request, or erase information already seen in the conversation.

Maintenance rules guide the agent but are not enforced by a filesystem sandbox. Other workflow restrictions still apply: for example, Plan Mode's discussion stage can prevent memory writes even while Memory is ON.

The extension only reads `index.md`. The agent uses normal read/write/edit tools for memory maintenance, updates the index itself, and decides whether retrieval or saving is useful.

## Implementation

- `index.ts`: runtime boolean, `/memory`, dim status, session reset, and a `before_agent_start` prompt contribution.
- `memory-rules.md`: flat-storage, concise-index, deduplication, accuracy, and maintenance guidance.
- `memory-test.mjs`: focused regression harness using Pi's prompt builder and temporary fixtures.

No additional runtime dependencies are required beyond Pi and Node.js built-ins. Tested with Pi 1.4.0.

## Tests

From the repository root:

```sh
node extensions/memory/memory-test.mjs
# Or run the entire collection:
npm test
```

Tests find Pi's managed 1.4.0 installation by default. Set `PI_TEST_INSTALL` to its `node_modules` directory when using a different installation location.

Coverage includes default OFF, toggles, index refresh, missing/empty/unreadable indexes, prompt removal, unchanged workflow guidance and tools, dim status, and headless operation. Session startup/resume/reload are simulated. Tests use a temporary home and synthetic memory files, not real memories or model calls.

Interactive rendering and actual model adherence to maintenance rules require manual verification.
