# pi-plan-tools

Plan management, execution, and permission enforcement for [pi](https://github.com/earendil-works/pi-coding-agent) — save and submit plans for review, execute approved plans in clean sessions, cycle permission modes, and enforce ask/plan/auto-approve rules.

This is a **multi-extension bundle** — four separate extensions packaged in a single npm module, covering the full plan lifecycle: write → review → approve → execute, with configurable permission enforcement throughout.

---

## Features

| Extension | Tool(s) | Command(s) | Lines | Description |
|-----------|---------|------------|-------|-------------|
| **plan-utils** | `plan_save`, `plan_submit`, `annotate` | — | 477 | Save plan markdown to disk and open it in the Plannotator browser UI for human review. |
| **execute-plan** | — | `/execute-plan` | 153 | Launch a clean build-mode session with the approved plan pre-seeded after Plannotator approval. |
| **permission-plan-mode** | — | `/permissions` | 1,369 | Shift+Tab mode cycling (bypass / plan / ask) with Claude Code-style allow/deny pattern rules. |
| **plannotator-permissions-enhancer** | `plannotator_exit_plan` | — | 273 | Exit plan mode and return to build mode — bridges Plannotator approval with permission state. |

### Key Design Principles

- **Full plan lifecycle** — Write a plan → submit for human review → get approval → execute in a clean session. Each stage is a separate extension that can be used independently.
- **Human-in-the-loop** — `plan_submit` blocks until the user approves, denies with feedback, or dismisses. No autonomous execution without explicit approval.
- **Configurable permission enforcement** — Three modes (bypass, plan, ask) cycle via Shift+Tab. Ask mode uses Claude Code-style allow/deny rules for fine-grained tool control.
- **Cross-extension coordination** — The plannotator-permissions-enhancer listens for mode-change events from permission-plan-mode and emits mode-switch events to exit plan mode when a plan is approved.

---

## Installation

```bash
# Install as a pi extension package
pi extensions install npm:pi-plan-tools
```

Or reference directly in your `settings.json`:

```json
{
  "extensions": ["npm:pi-plan-tools"]
}
```

All four extensions in the bundle are registered automatically — no need to configure individual files.

---

## API Reference

### Plan Management (plan-utils.ts)

#### `plan_save` Tool

Write a plan to `~/.pi/plans/<project>/<date>/<slug>.md` by default, or to `<cwd>/<date>/<slug>.md` when a custom directory is provided. Returns the absolute file path.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | ✅ | Full markdown content of the plan. |
| `filename` | `string` | ❌ | Optional slug hint for the filename (e.g. `auth-refactor`). Derived from the first heading if omitted. |
| `cwd` | `string` | ❌ | Optional target directory. Defaults to `~/.pi/plans/<project>/<date>`. |

#### `plan_submit` Tool

Open a file in the Plannotator browser UI for human review. Blocks until the user approves, denies with feedback, or dismisses. Returns the decision and any feedback annotations.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | `string` | ✅ | Path to the file to review. Absolute paths are used as-is; relative paths are resolved against `cwd`. |
| `cwd` | `string` | ❌ | Base directory for resolving relative `filePath`. |

#### `annotate` Tool

Alias for `plan_submit` — display and annotate markdown files (or any file Plannotator can open) in the browser UI.

### Plan Execution (execute-plan.ts)

#### `/execute-plan` Command

Start a clean new build-mode session with the approved plan pre-seeded. Automatically triggered after plan approval (editor pre-filled with `/execute-plan`). Can also be typed manually after approving a plan.

**Post-approval flow:**

1. `plan_submit` emits `plannotator:new-session-approved` synchronously.
2. The event listener stores `filePath` + `planContent` in `pendingSession`.
3. A `ui.select` prompt asks the user: new session or same session.
4. **New session** — Editor is pre-filled with `/execute-plan`; user presses Enter → the command handler fires → `launchPlanSession()` starts the new session.
5. **Same session** — `plannotator-wrapper:execute-same-session` is emitted for in-session execution.

### Permission Enforcement (permission-plan-mode.ts)

#### `/permissions` Command

Displays current permission mode and available modes. Cycles through modes via Shift+Tab.

**Modes:**

| Mode | Behavior |
|------|----------|
| **bypassPermissions** | All tools allowed (default startup mode). |
| **plan** | Read-only — injects planning instructions, blocks write tools. |
| **ask** | Claude Code-style allow/deny pattern rules. Prompts user for unapproved tools. |

**Ask mode rules** are defined in `~/.pi/agent/permissions.json` using patterns like:

```json
{
  "allow": ["Bash(npm test:*)", "Bash(npm run lint:*)", "Read(*)"],
  "deny": ["Bash(rm -rf:*)"]
}
```

Rules support prefix matching (`:*`), wildcard (`*`), and per-tool granularity (`bash`, `edit`, `write`, `read`).

### Plan-Permission Bridge (plannotator-permissions-enhancer.ts)

#### `plannotator_exit_plan` Tool

Exit plan mode and return to build mode with full tool access. Use this for a same-session exit (e.g. the user asks to stop planning). When `plan_submit` is approved, the extension automatically exits plan mode — no manual call needed.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reason` | `string` | ❌ | Why plan mode is being exited. |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          pi-plan-tools                             │
│                                                                    │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │  plan-utils.ts  │  │  execute-plan.ts │  │ permission-      │ │
│  │                 │  │                  │  │ plan-mode.ts     │ │
│  │  plan_save ─────┼──┼─▶ /execute-plan  │  │                  │ │
│  │  plan_submit    │  │  launches clean  │  │  Shift+Tab mode  │ │
│  │  annotate       │  │  session with    │  │  cycling:        │ │
│  │       │         │  │  plan pre-seeded │  │  bypass → plan   │ │
│  │       ▼         │  │                  │  │  → ask           │ │
│  │  Plannotator    │  │  Post-approval:  │  │                  │ │
│  │  browser UI     │  │  event listener  │  │  Ask rules from  │ │
│  │  (approve/deny) │  │  stores plan,    │  │  permissions.json│ │
│  │       │         │  │  ui.select →     │  │                  │ │
│  │       ▼         │  │  new vs same     │  │  /permissions    │ │
│  │  approve event  │  │  session         │  │  command         │ │
│  └────────┬────────┘  └──────────────────┘  └────────┬─────────┘ │
│           │                                           │           │
│           │     ┌──────────────────────────┐          │           │
│           └────▶│  plannotator-            │◀─────────┘           │
│                 │  permissions-enhancer.ts │                      │
│                 │                          │                      │
│                 │  plannotator_exit_plan   │                      │
│                 │  exits plan mode →       │                      │
│                 │  build mode              │                      │
│                 └──────────────────────────┘                      │
│                                                                    │
│  Tools:  plan_save / plan_submit / annotate / plannotator_exit_plan│
│  Cmds:   /execute-plan / /permissions                              │
└──────────────────────────────────────────────────────────────────┘
```

### Cross-Extension Event Flow

The four extensions coordinate via pi's event bus:

| Event | Emitter | Listener | Purpose |
|-------|---------|----------|---------|
| `plannotator:new-session-approved` | `plan_submit` | `execute-plan` | Triggers plan storage + session prompt |
| `plannotator-wrapper:plan-approved` | `execute-plan` | `@plannotator/pi-extension` | Suppresses in-place continueWhenIdle fallback |
| `pi-claude-permissions:set-mode` | `plannotator_exit_plan` | `permission-plan-mode` | Switches mode (e.g. plan → bypass) |
| `pi-claude-permissions:mode-changed` | `permission-plan-mode` | `plannotator-permissions-enhancer` | Tracks current mode state |

---

## Future Work

- **Plan templates** — Pre-built plan scaffolds for common workflows (feature, bugfix, refactor).
- **Approval persistence** — Track plan approval history for audit trails.
- **Conditional ask rules** — Allow/deny rules scoped to specific plan modes or project directories.

---

## License

MIT © [javapacr](https://github.com/javapacr)
