# pi-plan-tools

Plan tools for [pi](https://github.com/earendil-works/pi-coding-agent) — save a plan and open it for human review with Plannotator. The repo also carries two unloaded permission-mode source files.

The manifest (`package.json` `pi.extensions`) loads one extension, `plan-utils.ts`. `permission-plan-mode.ts` and `plannotator-permissions-enhancer.ts` are kept as source and are not loaded.

---

## Features

| Extension | Tool(s) | Command(s) | Lines | Description |
|-----------|---------|------------|-------|-------------|
| **plan-utils** | `plan_save`, `plan_submit`, `annotate` | — | 735 | Save plan markdown to disk and open it (or a folder of Markdown files) for human review: plannotator-tui in a Herdr pane (returns at once; feedback arrives as the next user message) or the Plannotator browser gate. |
| **permission-plan-mode** | — | `/permissions` | 1,369 | Shift+Tab mode cycling (bypass / plan / ask) with Claude Code-style allow/deny pattern rules. |
| **plannotator-permissions-enhancer** | `plannotator_exit_plan` | — | 273 | Exit plan mode and return to build mode — bridges Plannotator approval with permission state. |

### Key Design Principles

- **Plan → review** — Write a plan (`plan_save`), then open it for human review (`plan_submit` / `annotate`). The reviewer's feedback reaches the agent, and the caller decides what happens next.
- **Human-in-the-loop** — Inside Herdr, `plan_submit` / `annotate` open plannotator-tui in a pane and return at once with an instruction to end the turn; the human's feedback arrives as the next user message. Elsewhere they run the Plannotator browser gate, which blocks until the user approves, sends feedback, or dismisses, and returns a plain result.
- **Configurable permission enforcement** — Three modes (bypass, plan, ask) cycle via Shift+Tab. Ask mode uses Claude Code-style allow/deny rules for fine-grained tool control.
- **Cross-extension coordination** — The plannotator-permissions-enhancer listens for mode-change events from permission-plan-mode and emits mode-switch events when `plannotator_exit_plan` is called.

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

Only `plan-utils.ts` is registered; the two permission files are unloaded source.

---

## Configuration

`plan_submit` / `annotate` pick their review backend from `planTools.reviewBackend` in the profile `settings.json` (`$PI_CODING_AGENT_DIR/settings.json`; `~/.pi/agent/settings.json` when `PI_CODING_AGENT_DIR` is unset). The file is re-read on every call.

```json
{ "planTools": { "reviewBackend": "auto" } }
```

| Value | Behaviour |
|-------|-----------|
| `auto` (default) | Open plannotator-tui in a Herdr pane when every precondition holds (`HERDR_ENV=1`, `HERDR_PANE_ID` set, `plannotator-tui` on `PATH`, interactive UI, not a subagent child); otherwise run the browser gate and prefix the result with `plannotator-tui unavailable (<reason>); used the browser review instead.` |
| `tui` | Same as `auto` today (reserved for a future stricter mode). |
| `browser` | Always run the Plannotator browser gate (`plannotator annotate <path> --gate --json`); no TUI attempt, no note. |

A missing file, missing `planTools` block, malformed JSON, or unknown value means `auto`.

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

Open a file, or a folder of Markdown files, for human review. A folder opens with a file tree and yields one combined review across its files; it must hold a Markdown file (`.md`, `.mdx`, `.markdown`) within two levels, skipping dot-prefixed subfolders, and a file must be non-empty. The backend is chosen per call from `planTools.reviewBackend` (see [Configuration](#configuration)) and the environment:

- **plannotator-tui (Herdr)** — used when `HERDR_ENV=1`, `HERDR_PANE_ID` is set, `plannotator-tui` is on `PATH`, the session has an interactive UI, and it is not a pi-subagents child (`PI_SUBAGENT_CHILD` unset). Runs `plannotator-tui herdr open <abs-path>` (placement from `~/.config/plannotator-tui/config.toml`) and returns immediately with:

  ```text
  Review opened in plannotator-tui: pane <pane-id>, file <abs-path>.   ("folder <abs-path>" for a folder)
  End your turn now. Do not wait, poll, or read the review pane. The human's feedback (or a go-ahead) arrives as the next user message; address every item, then continue.
  ```

  `details` are `{ backend: "tui", paneId, filePath }`, plus `isFolder: true` for a folder.
- **Plannotator browser gate** — when `planTools.reviewBackend` is `browser`, or when the TUI can't be used. Runs `plannotator annotate <file | folder/> --gate --json` and blocks until the user approves (`Review approved.`, plus any feedback), sends feedback, or dismisses. When the TUI could not be used, the result starts with `plannotator-tui unavailable (<reason>); used the browser review instead.` `details` carry `backend: "browser"` and, on fallback, `fallbackReason`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | `string` | ✅ | Path to the file, or folder of Markdown files, to review. Absolute paths are used as-is; relative paths are resolved against `cwd`. |
| `cwd` | `string` | ❌ | Base directory for resolving relative `filePath`. |

#### `annotate` Tool

Alias for `plan_submit` — same parameters, same backends and results; use it to display and annotate markdown files (or any file Plannotator can open), or a folder of Markdown files as one review.

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

Exit plan mode and return to build mode with full tool access. Use this for a same-session exit (e.g. the user asks to stop planning). `plan_submit` approval does not exit plan mode; call this tool explicitly.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reason` | `string` | ❌ | Why plan mode is being exited. |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          pi-plan-tools                           │
│                                                                  │
│  ┌──────────────────────────┐    ┌────────────────────────────┐  │
│  │  plan-utils.ts           │    │  permission-plan-mode.ts   │  │
│  │                          │    │  (unloaded source)         │  │
│  │  plan_save               │    │                            │  │
│  │  plan_submit             │    │  Shift+Tab mode cycling:   │  │
│  │  annotate                │    │  bypass → plan → ask       │  │
│  │       │                  │    │                            │  │
│  │       ▼                  │    │  Ask rules from            │  │
│  │  plannotator-tui pane    │    │  permissions.json          │  │
│  │  (Herdr) or Plannotator  │    │                            │  │
│  │  browser gate            │    │  /permissions command      │  │
│  └──────────────────────────┘    └─────────────┬──────────────┘  │
│                                                │                 │
│                 ┌──────────────────────────┐   │                 │
│                 │  plannotator-            │◀──┘                 │
│                 │  permissions-enhancer.ts │                     │
│                 │  (unloaded source)       │                     │
│                 │                          │                     │
│                 │  plannotator_exit_plan   │                     │
│                 │  exits plan mode →       │                     │
│                 │  build mode              │                     │
│                 └──────────────────────────┘                     │
│                                                                  │
│  Tools:  plan_save / plan_submit / annotate                      │
│  Cmds:   /permissions (unloaded source)                          │
└──────────────────────────────────────────────────────────────────┘
```

### Cross-Extension Event Flow

The two permission source files coordinate via pi's event bus (neither is loaded by the manifest):

| Event | Emitter | Listener | Purpose |
|-------|---------|----------|---------|
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
