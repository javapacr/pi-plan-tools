/**
 * Opinionated Permissions + Plan Mode + Ask Mode for pi
 *
 * Inspired by rHedBull/pi-permissions, trimmed down for this workflow:
 * - Shift+Tab cycles configurable modes.
 * - Default startup mode is bypassPermissions.
 * - Plan mode is read-only and injects planning instructions.
 * - Ask mode uses Claude Code-style allow/deny pattern rules.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type PermissionMode = string;
type Pattern = { pattern: string; description: string };
type UiContext = {
  ui: any;
  hasUI?: boolean;
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  cwd?: string;
};

interface SessionAllow {
  tools: Set<string>;
  commands: Set<string>;
}

// === Claude Code-style permission rules ===

interface PermissionRule {
  /** Lowercase tool name: "bash", "edit", "write", "read", or "*" */
  tool: string;
  /** Pattern value inside parens, or null for wildcard (Tool(*)) */
  value: string | null;
  /** Whether this is a prefix match (ends with :*) for bash */
  prefix: boolean;
  /** Original raw string for display: "Bash(npm test:*)" */
  raw: string;
}

interface AskRules {
  allow: PermissionRule[];
  deny: PermissionRule[];
}

// === Existing types ===

interface CustomModePolicy {
  excludedTools?: string[];
  allowedWriteRoots?: Array<"cwd" | "parent" | string>;
  blockedBashPatterns?: Pattern[];
  network?: {
    allowLocalhostOnly?: boolean;
    allowGithubReadOnly?: boolean;
    allowedPorts?: number[];
  };
}

interface ModeDefinition {
  id: PermissionMode;
  label: string;
  description: string;
  status: string;
  policy?: CustomModePolicy;
}

interface PermissionsConfig {
  mode?: string;
  dangerousPatterns?: Pattern[];
  catastrophicPatterns?: Pattern[];
  protectedPaths?: string[];
  allowCatastrophic?: boolean;
  shiftTabOptions?: string[];
  defaultMode?: string;
  hideDefaultMode?: boolean;
  planModeAllowedMcpServers?: string[];
  planModeAllowedTools?: string[];
  customModes?: ModeDefinition[];
  // Ask mode rules
  askRules?: {
    allow?: string[];
    deny?: string[];
  };
  persistAllows?: "project" | "global" | false;
}

interface PiSettingsConfig {
  piClaudePermissions?: {
    allowCatastrophic?: boolean;
    shiftTabOptions?: string[];
    defaultMode?: string;
    hideDefaultMode?: boolean;
    planModeAllowedMcpServers?: string[];
    planModeAllowedTools?: string[];
    customModes?: ModeDefinition[];
    askRules?: {
      allow?: string[];
      deny?: string[];
    };
    persistAllows?: "project" | "global" | false;
  };
}

const DEFAULT_MODE: PermissionMode = "bypassPermissions";
const PLAN_BLOCK_REASON = "You are in plan mode, you can only read files/search tools until the user exits plan mode.";

const BUILT_IN_MODES: ModeDefinition[] = [
  { id: "default", label: "Default", description: "Ask before write/edit/bash operations", status: "⏵" },
  { id: "ask", label: "Ask", description: "Pattern-based allow/deny rules, prompt for the rest", status: "🔒" },
  { id: "plan", label: "Plan", description: "Read-only exploration; only read/search tools and safe bash", status: "⏸" },
  { id: "acceptEdits", label: "Accept Edits", description: "Allow write/edit silently, confirm bash", status: "⏵⏵" },
  { id: "bypassPermissions", label: "Bypass Permissions", description: "Allow everything except catastrophic/protected operations", status: "⏵⏵⏵⏵" },
];

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "rg", "fd", "bat", "eza", "mcp"];
const GATED_TOOLS = new Set(["write", "edit", "bash"]);

const SAFE_PLAN_BASH_PREFIXES = [
  "cat", "head", "tail", "less", "more", "grep", "find", "ls",
  "pwd", "echo", "printf", "wc", "sort", "uniq", "diff", "file",
  "stat", "du", "df", "tree", "which", "whereis", "type", "env",
  "printenv", "uname", "whoami", "id", "date", "cal", "uptime",
  "ps", "top", "htop", "free", "curl", "jq", "sed", "awk",
  "rg", "fd", "bat", "eza", "git status", "git log", "git diff",
  "git show", "git branch", "git remote", "git ls-", "git config --get",
  "gh pr view", "gh pr list", "gh pr diff", "gh pr checks", "gh pr status",
  "gh issue view", "gh issue list", "gh issue status", "gh repo view",
  "gh run view", "gh run list", "gh release view", "gh release list",
  "gh api", "gh auth status", "npm list", "npm ls", "npm view",
  "npm info", "npm search", "npm outdated", "npm audit",
];

const DEFAULT_DANGEROUS: Pattern[] = [
  { pattern: "chmod -R 777", description: "insecure recursive permissions" },
  { pattern: "chown -R", description: "recursive ownership change" },
  { pattern: "> /dev/", description: "direct device write" },
];

const DEFAULT_CATASTROPHIC: Pattern[] = [
  { pattern: "sudo mkfs", description: "sudo filesystem format" },
  { pattern: "mkfs.", description: "filesystem format" },
  { pattern: "dd if=", description: "raw disk write" },
  { pattern: ":(){ :|:& };:", description: "fork bomb" },
  { pattern: "> /dev/sda", description: "overwrite disk" },
  { pattern: "> /dev/nvme", description: "overwrite disk" },
  { pattern: "sudo dd", description: "sudo raw disk operation" },
];

const CRITICAL_DIRS = [
  "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt",
  "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var",
];

const DEFAULT_PROTECTED_PATHS = [
  "~/.ssh", "~/.aws", "~/.gnupg", "~/.gpg", "~/.bashrc", "~/.bash_profile",
  "~/.profile", "~/.zshrc", "~/.zprofile", "~/.config/git/credentials",
  "~/.netrc", "~/.npmrc", "~/.docker/config.json", "~/.kube/config", "~/.pi/agent/auth.json",
];

const PLAN_MODE_MESSAGE = `[PLAN MODE]
Read/search only. Do not edit files, write files, or run mutating commands.

Inspect what you need, then give the user a clear plan with the files and changes involved. Wait for the user to toggle out of plan mode before executing.`;

const PLAN_MODE_ENDED_MESSAGE = `[PLAN MODE ENDED]
The user toggled out of plan mode. You may now execute the plan using the active permission mode.`;

const ASK_MODE_MESSAGE = `[ASK MODE]
Pattern-based permissions are active. Tool calls matching allow rules are auto-approved; deny rules always block; everything else prompts interactively.
Use /permissions to view or manage rules.`;

// Default ask rules — read-only tools are always safe
const DEFAULT_ASK_ALLOW = [
  "Read(*)",
  "Grep(*)",
  "Find(*)",
  "Ls(*)",
];

export default async function permissionExtension(pi: ExtensionAPI) {
  pi.registerFlag("permission-mode", {
    description: "Permission mode (default, ask, plan, acceptEdits, bypassPermissions)",
    type: "string",
    default: "",
  });
  pi.registerFlag("dangerously-skip-permissions", {
    description: "Bypass all permission checks except catastrophic/protected checks",
    type: "boolean",
    default: false,
  });

  const config = await loadConfig();
  const home = homedir();
  const sessionAllow: SessionAllow = { tools: new Set(), commands: new Set() };
  const dangerousPatterns = config.dangerousPatterns ?? DEFAULT_DANGEROUS;
  const catastrophicPatterns = config.catastrophicPatterns ?? DEFAULT_CATASTROPHIC;
  const protectedPaths = (config.protectedPaths ?? DEFAULT_PROTECTED_PATHS).map((path) =>
    path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(path),
  );
  const allowCatastrophic = config.allowCatastrophic === true;
  const modes = buildModeDefinitions(config.customModes);
  const defaultMode = normalizeMode(config.defaultMode, DEFAULT_MODE, modes);
  const hideDefaultMode = config.hideDefaultMode === true;
  const planModeAllowedMcpServers = new Set(config.planModeAllowedMcpServers ?? []);
  const planModeAllowedTools = new Set(config.planModeAllowedTools ?? []);
  const shiftTabModes = normalizeShiftTabOptions(config.shiftTabOptions, modes);

  // Ask mode rules — mutable at runtime for "always allow" persistence
  let askRules = loadAskRules(config);
  const persistAllows = config.persistAllows ?? "project";

  let mode = normalizeMode(config.mode, defaultMode, modes);
  let previousActiveTools: string[] | null = null;
  let planContextPending = mode === "plan";
  let planEndedContextPending = false;
  let askContextPending = mode === "ask";

  const clearSessionAllows = () => {
    sessionAllow.tools.clear();
    sessionAllow.commands.clear();
  };

  const restoreToolsAfterPlan = () => {
    if (!previousActiveTools) return;
    pi.setActiveTools(previousActiveTools);
    previousActiveTools = null;
  };

  const enterPlanToolScope = () => {
    if (!previousActiveTools) previousActiveTools = pi.getActiveTools();
    pi.setActiveTools(PLAN_MODE_TOOLS);
  };

  const updateStatus = (ctx: UiContext) => {
    if (hideDefaultMode && mode === defaultMode) {
      ctx.ui.setStatus("permissions", undefined);
      return;
    }

    const meta = getModeMeta(mode, modes);
    ctx.ui.setStatus("permissions", `${meta.status} ${meta.label}`);
  };

  const applyMode = async (nextMode: PermissionMode, ctx: UiContext) => {
    const wasPlan = mode === "plan";
    const enteringPlan = nextMode === "plan" && !wasPlan;
    const leavingPlan = wasPlan && nextMode !== "plan";

    mode = nextMode;
    clearSessionAllows();

    if (enteringPlan || nextMode === "plan") {
      enterPlanToolScope();
      planContextPending = true;
      planEndedContextPending = false;
      askContextPending = false;
      ctx.ui.notify("In plan mode, only read files/search tools are allowed.", "info");
    } else {
      if (leavingPlan) {
        restoreToolsAfterPlan();
        planContextPending = false;
        planEndedContextPending = true;
      }
      if (nextMode === "ask") {
        askContextPending = true;
        ctx.ui.notify(`Permission mode: Ask (${askRules.allow.length} allow, ${askRules.deny.length} deny rules)`, "info");
      } else {
        askContextPending = false;
        ctx.ui.notify(`Permission mode: ${getModeMeta(mode, modes).label}`, "info");
      }
    }

    updateStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    clearSessionAllows();

    // Reload ask rules from config on each session start
    const freshConfig = await loadConfig();
    askRules = loadAskRules(freshConfig);

    if (pi.getFlag("dangerously-skip-permissions") === true) {
      mode = "bypassPermissions";
    } else {
      const flagMode = pi.getFlag("permission-mode");
      if (typeof flagMode === "string" && flagMode) mode = normalizeMode(flagMode, defaultMode, modes);
    }

    if (mode === "plan") {
      enterPlanToolScope();
      planContextPending = true;
      askContextPending = false;
    } else {
      restoreToolsAfterPlan();
      planContextPending = false;
      askContextPending = mode === "ask";
    }
    planEndedContextPending = false;

    updateStatus(ctx);
  });

  pi.registerShortcut("shift+tab", {
    description: `Cycle permission mode (${shiftTabModes.map((m) => getModeMeta(m, modes).label).join(" → ")})`,
    handler: async (ctx) => {
      const idx = shiftTabModes.findIndex((m) => m === mode);
      await applyMode(shiftTabModes[(idx + 1) % shiftTabModes.length]!, ctx);
    },
  });

  pi.registerCommand("permissions", {
    description: "Select permission mode or manage ask-mode rules",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/permissions requires interactive UI", "warning");
        return;
      }

      const trimmed = (args ?? "").trim();

      // Subcommands: /permissions allow <pattern>, /permissions deny <pattern>, /permissions list, /permissions remove
      if (trimmed) {
        await handlePermissionsSubcommand(trimmed, ctx);
        return;
      }

      // Default: show mode selector + rule management
      const modeOptions = modes.map((m) => `${m.status} ${m.label} — ${m.description}`);
      const ruleOptions: string[] = [];
      if (mode === "ask") {
        ruleOptions.push("─".repeat(40));
        ruleOptions.push(`📋 View rules (${askRules.allow.length} allow, ${askRules.deny.length} deny)`);
        ruleOptions.push("➕ Add allow rule…");
        ruleOptions.push("🚫 Add deny rule…");
        ruleOptions.push("➖ Remove a rule…");
      }

      const allOptions = [...modeOptions, ...ruleOptions];
      const selected = await ctx.ui.select("Permissions", allOptions);
      if (!selected) return;

      // Check if it's a mode selection
      const modeIdx = modeOptions.indexOf(selected);
      if (modeIdx >= 0) {
        await applyMode(modes[modeIdx]!.id, ctx);
        return;
      }

      // Rule management
      if (selected.includes("View rules")) {
        await showRules(ctx);
      } else if (selected.includes("Add allow")) {
        await addRuleInteractive(ctx, "allow");
      } else if (selected.includes("Add deny")) {
        await addRuleInteractive(ctx, "deny");
      } else if (selected.includes("Remove")) {
        await removeRuleInteractive(ctx);
      }
    },
  });

  pi.on("before_agent_start", async () => {
    if (mode === "plan" && planContextPending) {
      planContextPending = false;
      return {
        message: {
          customType: "plan-mode-context",
          content: PLAN_MODE_MESSAGE,
          display: true,
        },
      };
    }

    if (mode !== "plan" && planEndedContextPending) {
      planEndedContextPending = false;
      return {
        message: {
          customType: "plan-mode-ended-context",
          content: PLAN_MODE_ENDED_MESSAGE,
          display: true,
        },
      };
    }

    if (mode === "ask" && askContextPending) {
      askContextPending = false;
      return {
        message: {
          customType: "ask-mode-context",
          content: ASK_MODE_MESSAGE,
          display: true,
        },
      };
    }

    const modeMeta = getModeMeta(mode, modes);
    if (!modeMeta.policy || !modeMeta.description) return;
    return {
      message: {
        customType: "permission-mode-context",
        content: `[${modeMeta.label.toUpperCase()} MODE ACTIVE]\n${modeMeta.description}`,
        display: true,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    if (mode === "plan") return enforcePlanMode(toolName, event.input, planModeAllowedMcpServers, planModeAllowedTools);

    // === Ask mode: rule-based permissions ===
    if (mode === "ask") {
      // Always-on safety first
      const safetyBlock = await enforceAlwaysOnSafety({
        toolName,
        input: event.input,
        ctx,
        home,
        protectedPaths,
        catastrophicPatterns,
        allowCatastrophic,
      });
      if (safetyBlock) return safetyBlock;

      // Check deny rules
      for (const rule of askRules.deny) {
        if (matchesRule(toolName, event.input, rule)) {
          ctx.ui.notify(`🚫 Denied by rule: ${rule.raw}`, "warning");
          return { block: true as const, reason: `Denied by rule: ${rule.raw}` };
        }
      }

      // Check allow rules — auto-approve
      if (askRules.allow.some((rule) => matchesRule(toolName, event.input, rule))) return;

      // Check session allows (e.g., from previous "allow for session" choice)
      if (isSessionAllowed(toolName, event.input, sessionAllow)) return;

      // Prompt interactively
      if (!ctx.hasUI) {
        return { block: true as const, reason: `Blocked ${toolName} (no UI for confirmation, mode: ask)` };
      }

      return promptAskApproval(toolName, event.input, ctx, dangerousPatterns, catastrophicPatterns, sessionAllow, allowCatastrophic, askRules, persistAllows);
    }

    // === Existing modes ===
    const modeMeta = getModeMeta(mode, modes);
    const customPolicy = modeMeta.policy;
    if (!customPolicy && mode !== "default" && !GATED_TOOLS.has(toolName)) return;

    const safetyBlock = await enforceAlwaysOnSafety({
      toolName,
      input: event.input,
      ctx,
      home,
      protectedPaths,
      catastrophicPatterns,
      allowCatastrophic,
    });
    if (safetyBlock) return safetyBlock;

    if (customPolicy) return enforceCustomMode(toolName, event.input, ctx, customPolicy);
    if (mode === "bypassPermissions") return;
    if (mode === "acceptEdits" && (toolName === "write" || toolName === "edit")) return;

    if (isSessionAllowed(toolName, event.input, sessionAllow)) return;

    if (!ctx.hasUI) {
      return { block: true as const, reason: `Blocked ${toolName} (no UI for confirmation, mode: ${mode})` };
    }

    return promptApproval(toolName, event.input, ctx, dangerousPatterns, catastrophicPatterns, sessionAllow, allowCatastrophic);
  });

  // === Rule management helpers ===

  async function handlePermissionsSubcommand(args: string, ctx: UiContext) {
    const parts = args.split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    const rest = parts.slice(1).join(" ");

    switch (sub) {
      case "list":
      case "rules":
        await showRules(ctx);
        break;
      case "allow":
        if (!rest) { ctx.ui.notify("Usage: /permissions allow <pattern>", "warning"); return; }
        await addRule(rest, "allow", ctx);
        break;
      case "deny":
        if (!rest) { ctx.ui.notify("Usage: /permissions deny <pattern>", "warning"); return; }
        await addRule(rest, "deny", ctx);
        break;
      case "remove":
      case "rm":
        await removeRuleInteractive(ctx);
        break;
      default:
        ctx.ui.notify("Unknown subcommand. Use: list, allow <pattern>, deny <pattern>, remove", "warning");
    }
  }

  async function showRules(ctx: UiContext) {
    const lines: string[] = [];
    lines.push("📋 Permission Rules (ask mode)\n");
    lines.push(`✅ ALLOW (${askRules.allow.length}):`);
    if (askRules.allow.length === 0) lines.push("   (none)");
    else askRules.allow.forEach((r, i) => lines.push(`   ${i + 1}. ${r.raw}`));

    lines.push("");
    lines.push(`🚫 DENY (${askRules.deny.length}):`);
    if (askRules.deny.length === 0) lines.push("   (none)");
    else askRules.deny.forEach((r, i) => lines.push(`   ${i + 1}. ${r.raw}`));

    lines.push("");
    lines.push(`Persistence: ${persistAllows === false ? "session only" : persistAllows}`);

    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function addRuleInteractive(ctx: UiContext, bucket: "allow" | "deny") {
    const input = await ctx.ui.input(
      `Enter ${bucket} rule (e.g. Bash(npm test:*), Edit(src/**), Read(*))`,
    );
    if (!input?.trim()) return;
    await addRule(input.trim(), bucket, ctx);
  }

  async function addRule(pattern: string, bucket: "allow" | "deny", ctx: UiContext) {
    const rule = parseRule(pattern);
    if (!rule) {
      ctx.ui.notify(`Invalid rule format: "${pattern}". Use Tool(pattern), e.g. Bash(npm:*)`, "error");
      return;
    }

    const arr = bucket === "allow" ? askRules.allow : askRules.deny;
    if (arr.some((r) => r.raw === rule.raw)) {
      ctx.ui.notify(`Rule already exists: ${rule.raw}`, "warning");
      return;
    }

    arr.push(rule);
    ctx.ui.notify(`✅ Added ${bucket} rule: ${rule.raw}`, "info");

    if (persistAllows !== false) {
      const saved = await persistRules();
      if (saved) ctx.ui.notify(`Saved to ${persistAllows} settings`, "info");
    }
  }

  async function removeRuleInteractive(ctx: UiContext) {
    const all = [...askRules.allow.map((r, i) => ({ bucket: "allow" as const, idx: i, raw: r.raw })),
                 ...askRules.deny.map((r, i) => ({ bucket: "deny" as const, idx: i, raw: r.raw }))];
    if (all.length === 0) {
      ctx.ui.notify("No rules to remove", "warning");
      return;
    }

    const options = all.map((r) => `${r.bucket === "allow" ? "✅" : "🚫"} ${r.raw}`);
    const selected = await ctx.ui.select("Remove which rule?", options);
    if (!selected) return;

    const idx = options.indexOf(selected);
    if (idx < 0) return;
    const target = all[idx]!;

    const arr = target.bucket === "allow" ? askRules.allow : askRules.deny;
    arr.splice(target.idx, 1);
    ctx.ui.notify(`Removed rule: ${target.raw}`, "info");

    if (persistAllows !== false) {
      await persistRules();
    }
  }

  async function persistRules(): Promise<boolean> {
    if (persistAllows === false) return false;

    const settingsPath = persistAllows === "global"
      ? resolve(homedir(), ".pi/agent/settings.json")
      : resolve(process.cwd(), ".pi/settings.json");

    try {
      const raw = await readFile(settingsPath, "utf-8").catch(() => "{}");
      const settings = JSON.parse(raw);
      if (!settings.piClaudePermissions) settings.piClaudePermissions = {};
      settings.piClaudePermissions.askRules = {
        allow: askRules.allow.map((r) => r.raw),
        deny: askRules.deny.map((r) => r.raw),
      };
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}

// === Ask mode: rule parsing and matching ===

function loadAskRules(config: PermissionsConfig): AskRules {
  const rawAllow = config.askRules?.allow ?? DEFAULT_ASK_ALLOW;
  const rawDeny = config.askRules?.deny ?? [];

  const allow = rawAllow.map(parseRule).filter((r): r is PermissionRule => r !== null);
  const deny = rawDeny.map(parseRule).filter((r): r is PermissionRule => r !== null);

  return { allow, deny };
}

/**
 * Parse a Claude Code-style permission rule.
 *
 * Supported formats:
 *   Bash(npm test:*)  → prefix match for bash commands starting with "npm test"
 *   Bash(npm test)    → exact match for bash command
 *   Bash(*)           → all bash commands
 *   Edit(src/**)      → glob match for edit file paths
 *   Write(src/**)     → glob match for write file paths
 *   Read(*)           → all reads
 *   Read(docs/**)     → glob match for read file paths
 *   MCP(*)            → all MCP calls
 *   read              → shorthand for Read(*) (no parens = wildcard)
 */
function parseRule(raw: string): PermissionRule | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Format: Tool(value) or just Tool
  const match = trimmed.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return null;

  const [, toolPart, valuePart] = match;
  const tool = (toolPart ?? "").toLowerCase();
  if (!tool) return null;

  // No parens = wildcard for that tool
  if (valuePart === undefined) {
    return { tool, value: null, prefix: false, raw: trimmed };
  }

  // "*" = wildcard
  if (valuePart === "*") {
    return { tool, value: null, prefix: false, raw: trimmed };
  }

  // Prefix match: "cmd:*" for bash
  const prefixMatch = valuePart.match(/^(.+):\*$/);
  if (prefixMatch) {
    return { tool, value: prefixMatch[1]!, prefix: true, raw: trimmed };
  }

  // Exact or glob match
  return { tool, value: valuePart, prefix: false, raw: trimmed };
}

/**
 * Check if a tool call matches a permission rule.
 */
function matchesRule(toolName: string, input: Record<string, unknown>, rule: PermissionRule): boolean {
  // Tool name check (case-insensitive)
  if (rule.tool !== "*" && rule.tool !== toolName.toLowerCase()) return false;

  // Wildcard — matches any call to this tool
  if (rule.value === null) return true;

  // Bash: prefix or exact match
  if (toolName === "bash") {
    const command = String(input.command ?? "").trim();
    if (rule.prefix) {
      return command.startsWith(rule.value);
    }
    // Try as exact match, or fall back to substring
    return command === rule.value || command.startsWith(rule.value + " ") ;
  }

  // File-based tools: glob match
  if (toolName === "write" || toolName === "edit" || toolName === "read") {
    const filePath = String(input.path ?? "");
    return globMatch(rule.value, filePath);
  }

  // For other tools, check if the value is a wildcard
  return rule.value === "*";
}

/**
 * Simple glob matcher supporting **, *, ?, and literal characters.
 *   ** → matches any path segments (including /)
 *   *  → matches anything except /
 *   ?  → matches single char except /
 */
function globMatch(pattern: string, path: string): boolean {
  // Normalize: resolve relative paths
  const normalizedPath = resolve(path);

  // Build regex from glob
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      // ** matches everything including /
      regexStr += ".*";
      i += 2;
      // Skip optional trailing /
      if (pattern[i] === "/") i++;
    } else if (char === "*") {
      // * matches everything except /
      regexStr += "[^/]*";
      i++;
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (".+^$(){}[]|\\".includes(char)) {
      regexStr += "\\" + char;
      i++;
    } else if (char === "~" && i === 0) {
      // Expand ~ at start to home dir
      regexStr += homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  try {
    return new RegExp("^" + regexStr + "$").test(normalizedPath);
  } catch {
    return normalizedPath.includes(pattern);
  }
}

/**
 * Generate a permission rule pattern from a tool call (for "always allow").
 *   bash "npm run build --verbose" → Bash(npm run build:*)
 *   edit "/project/src/index.ts"   → Edit(~/project/src/**)
 *   write "/project/config.json"   → Write(~/project/**)
 *   read "/project/README.md"      → Read(*)
 */
function generateRulePattern(toolName: string, input: Record<string, unknown>): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  if (toolName === "bash") {
    const command = String(input.command ?? "").trim();
    // Take first 1-3 non-flag tokens as prefix
    const tokens = command.split(/\s+/).filter((t) => !t.startsWith("-"));
    const prefix = tokens.slice(0, Math.min(3, tokens.length)).join(" ");
    return prefix ? `Bash(${prefix}:*)` : "Bash(*)";
  }

  if (toolName === "edit" || toolName === "write") {
    const rawPath = String(input.path ?? "");
    const dir = rawPath.substring(0, rawPath.lastIndexOf("/"));
    if (!dir) return `${cap(toolName)}(*)`;

    // Shorten to home-relative if possible
    const home = homedir();
    const shortDir = dir.startsWith(home) ? "~" + dir.slice(home.length) : dir;
    // Use parent directory with ** glob
    return `${cap(toolName)}(${shortDir}/**)`;
  }

  if (toolName === "read") {
    return "Read(*)";
  }

  return `${cap(toolName)}(*)`;
}

/**
 * Interactive prompt for ask mode with "Allow once" / "Always allow" / "Deny" / "Allow for session".
 */
async function promptAskApproval(
  toolName: string,
  input: Record<string, unknown>,
  ctx: UiContext,
  dangerousPatterns: Pattern[],
  catastrophicPatterns: Pattern[],
  sessionAllow: SessionAllow,
  allowCatastrophic: boolean,
  askRules: AskRules,
  persistAllows: "project" | "global" | false,
): Promise<{ block: true; reason: string } | undefined> {
  const { icon, description } = describeApprovalRequest(toolName, input, dangerousPatterns, catastrophicPatterns, allowCatastrophic);
  const suggestedRule = generateRulePattern(toolName, input);

  const options = [
    "Allow once",
    `Always allow (${suggestedRule})`,
    toolName === "bash" ? "Allow this command for session" : `Allow all ${toolName} for session`,
    "Deny",
  ];

  const choice = await ctx.ui.select(`${icon} ${description}`, options);

  // Allow once
  if (choice === options[0]) return;

  // Always allow — add rule and persist
  if (choice === options[1]) {
    const rule = parseRule(suggestedRule);
    if (rule) {
      askRules.allow.push(rule);
      // Persist to settings file
      if (persistAllows !== false) {
        const settingsPath = persistAllows === "global"
          ? resolve(homedir(), ".pi/agent/settings.json")
          : resolve(process.cwd(), ".pi/settings.json");
        try {
          const raw = await readFile(settingsPath, "utf-8").catch(() => "{}");
          const settings = JSON.parse(raw);
          if (!settings.piClaudePermissions) settings.piClaudePermissions = {};
          if (!settings.piClaudePermissions.askRules) settings.piClaudePermissions.askRules = {};
          if (!Array.isArray(settings.piClaudePermissions.askRules.allow)) settings.piClaudePermissions.askRules.allow = [];
          if (!settings.piClaudePermissions.askRules.allow.includes(suggestedRule)) {
            settings.piClaudePermissions.askRules.allow.push(suggestedRule);
            await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
            ctx.ui.notify(`Rule saved: ${suggestedRule}`, "info");
          }
        } catch {
          ctx.ui.notify(`Could not persist rule (added for session only): ${suggestedRule}`, "warning");
        }
      } else {
        ctx.ui.notify(`Rule added for session: ${suggestedRule}`, "info");
      }
    }
    return;
  }

  // Allow for session
  if (choice === options[2]) {
    if (toolName === "bash") sessionAllow.commands.add(String(input.command ?? ""));
    else sessionAllow.tools.add(toolName);
    return;
  }

  // Deny
  return { block: true, reason: `User denied ${toolName}` };
}

async function loadConfig(): Promise<PermissionsConfig> {
  const globalPath = resolve(homedir(), ".pi/agent/extensions/permissions.json");
  const localPath = resolve(process.cwd(), ".pi/extensions/permissions.json");
  const globalSettingsPath = resolve(homedir(), ".pi/agent/settings.json");
  const localSettingsPath = resolve(process.cwd(), ".pi/settings.json");
  const global = await readJson<PermissionsConfig>(globalPath);
  const local = await readJson<PermissionsConfig>(localPath);
  const globalSettings = await readJson<PiSettingsConfig>(globalSettingsPath);
  const localSettings = await readJson<PiSettingsConfig>(localSettingsPath);

  return {
    mode: stringOrUndefined(local.mode ?? global.mode),
    dangerousPatterns: local.dangerousPatterns ?? global.dangerousPatterns ?? DEFAULT_DANGEROUS,
    catastrophicPatterns: local.catastrophicPatterns ?? global.catastrophicPatterns ?? DEFAULT_CATASTROPHIC,
    protectedPaths: local.protectedPaths ?? global.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    allowCatastrophic: localSettings.piClaudePermissions?.allowCatastrophic
      ?? globalSettings.piClaudePermissions?.allowCatastrophic
      ?? false,
    shiftTabOptions: localSettings.piClaudePermissions?.shiftTabOptions
      ?? globalSettings.piClaudePermissions?.shiftTabOptions
      ?? local.shiftTabOptions
      ?? global.shiftTabOptions,
    defaultMode: stringOrUndefined(localSettings.piClaudePermissions?.defaultMode
      ?? globalSettings.piClaudePermissions?.defaultMode
      ?? local.defaultMode
      ?? global.defaultMode),
    hideDefaultMode: localSettings.piClaudePermissions?.hideDefaultMode
      ?? globalSettings.piClaudePermissions?.hideDefaultMode
      ?? local.hideDefaultMode
      ?? global.hideDefaultMode,
    planModeAllowedMcpServers: stringArrayOrUndefined(localSettings.piClaudePermissions?.planModeAllowedMcpServers)
      ?? stringArrayOrUndefined(globalSettings.piClaudePermissions?.planModeAllowedMcpServers)
      ?? stringArrayOrUndefined(local.planModeAllowedMcpServers)
      ?? stringArrayOrUndefined(global.planModeAllowedMcpServers),
    planModeAllowedTools: stringArrayOrUndefined(localSettings.piClaudePermissions?.planModeAllowedTools)
      ?? stringArrayOrUndefined(globalSettings.piClaudePermissions?.planModeAllowedTools)
      ?? stringArrayOrUndefined(local.planModeAllowedTools)
      ?? stringArrayOrUndefined(global.planModeAllowedTools),
    customModes: localSettings.piClaudePermissions?.customModes
      ?? globalSettings.piClaudePermissions?.customModes
      ?? local.customModes
      ?? global.customModes,
    askRules: {
      allow: stringArrayOrUndefined(localSettings.piClaudePermissions?.askRules?.allow)
        ?? stringArrayOrUndefined(globalSettings.piClaudePermissions?.askRules?.allow)
        ?? stringArrayOrUndefined(local.askRules?.allow)
        ?? stringArrayOrUndefined(global.askRules?.allow),
      deny: stringArrayOrUndefined(localSettings.piClaudePermissions?.askRules?.deny)
        ?? stringArrayOrUndefined(globalSettings.piClaudePermissions?.askRules?.deny)
        ?? stringArrayOrUndefined(local.askRules?.deny)
        ?? stringArrayOrUndefined(global.askRules?.deny),
    },
    persistAllows: (localSettings.piClaudePermissions?.persistAllows
      ?? globalSettings.piClaudePermissions?.persistAllows
      ?? local.persistAllows
      ?? global.persistAllows) as PermissionsConfig["persistAllows"],
  };
}

async function readJson<T>(path: string): Promise<T | Record<string, never>> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function buildModeDefinitions(customModes: unknown): ModeDefinition[] {
  const modes = [...BUILT_IN_MODES];
  if (!Array.isArray(customModes)) return modes;

  for (const customMode of customModes) {
    const mode = normalizeCustomMode(customMode);
    if (!mode) continue;
    const existing = modes.findIndex((candidate) => candidate.id === mode.id);
    if (existing >= 0) modes[existing] = mode;
    else modes.push(mode);
  }

  return modes;
}

function normalizeCustomMode(value: unknown): ModeDefinition | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, any>;
  const id = stringOrUndefined(raw.id);
  const label = stringOrUndefined(raw.label);
  if (!id || !label) return;

  return {
    id,
    label,
    description: stringOrUndefined(raw.description) ?? label,
    status: stringOrUndefined(raw.status) ?? "⏵",
    policy: normalizeCustomModePolicy(raw.policy ?? raw),
  };
}

function normalizeCustomModePolicy(raw: Record<string, any>): CustomModePolicy | undefined {
  const policy: CustomModePolicy = {};
  if (Array.isArray(raw.excludedTools)) policy.excludedTools = raw.excludedTools.filter((tool: unknown): tool is string => typeof tool === "string");
  if (Array.isArray(raw.allowedWriteRoots)) policy.allowedWriteRoots = raw.allowedWriteRoots.filter((root: unknown): root is string => typeof root === "string");
  if (Array.isArray(raw.blockedBashPatterns)) {
    policy.blockedBashPatterns = raw.blockedBashPatterns
      .filter((pattern: unknown): pattern is Pattern => Boolean(pattern) && typeof pattern === "object" && typeof (pattern as Pattern).pattern === "string")
      .map((pattern: Pattern) => ({ pattern: pattern.pattern, description: pattern.description ?? pattern.pattern }));
  }
  if (raw.network && typeof raw.network === "object") {
    policy.network = {
      allowLocalhostOnly: raw.network.allowLocalhostOnly === true,
      allowGithubReadOnly: raw.network.allowGithubReadOnly === true,
      allowedPorts: Array.isArray(raw.network.allowedPorts)
        ? raw.network.allowedPorts.filter((port: unknown): port is number => Number.isInteger(port))
        : undefined,
    };
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function normalizeMode(mode: unknown, fallback: PermissionMode = DEFAULT_MODE, modes: ModeDefinition[] = BUILT_IN_MODES): PermissionMode {
  return parseMode(mode, modes) ?? fallback;
}

function parseMode(mode: unknown, modes: ModeDefinition[]): PermissionMode | undefined {
  if (typeof mode !== "string") return;
  if (modes.some((candidate) => candidate.id === mode)) return mode;
}

function normalizeShiftTabOptions(options: unknown, allModes: ModeDefinition[]): PermissionMode[] {
  if (!Array.isArray(options)) return allModes.map((mode) => mode.id);

  const modes = options
    .map((option) => parseMode(option, allModes))
    .filter((mode): mode is PermissionMode => mode !== undefined)
    .filter((mode, index, all) => all.indexOf(mode) === index);
  return modes.length > 0 ? modes : allModes.map((mode) => mode.id);
}

function getModeMeta(mode: PermissionMode, modes: ModeDefinition[]) {
  return modes.find((m) => m.id === mode) ?? modes.find((m) => m.id === DEFAULT_MODE)!;
}

function enforcePlanMode(toolName: string, input: Record<string, unknown>, allowedMcpServers: Set<string>, allowedTools: Set<string> = new Set()) {
  if (!PLAN_MODE_TOOLS.includes(toolName) && !allowedTools.has(toolName)) return { block: true as const, reason: PLAN_BLOCK_REASON };
  if (toolName === "bash" && !isSafePlanCommand(String(input.command ?? ""))) {
    return { block: true as const, reason: PLAN_BLOCK_REASON };
  }
  if (toolName === "mcp" && !isAllowedPlanModeMcpCall(input, allowedMcpServers)) {
    return { block: true as const, reason: "MCP is only allowed in plan mode for servers listed in piClaudePermissions.planModeAllowedMcpServers." };
  }
}

function isAllowedPlanModeMcpCall(input: Record<string, unknown>, allowedMcpServers: Set<string>): boolean {
  const server = stringOrUndefined(input.server ?? input.connect);
  return Boolean(server && allowedMcpServers.has(server));
}

function enforceCustomMode(toolName: string, input: Record<string, unknown>, ctx: UiContext, policy: CustomModePolicy) {
  if (policy.excludedTools?.includes(toolName)) {
    return { block: true as const, reason: `${toolName} is blocked in this permission mode.` };
  }

  if (toolName === "write" || toolName === "edit") {
    const targetPath = resolve(String(input.path ?? ""));
    if (!isPathInAllowedRoots(targetPath, ctx, policy.allowedWriteRoots)) {
      return { block: true as const, reason: `Write blocked outside allowed roots: ${targetPath}` };
    }
  }

  if (toolName === "bash") {
    const command = String(input.command ?? "");
    const blockedPattern = findCommandPatternMatch(command, policy.blockedBashPatterns ?? []);
    if (blockedPattern) {
      return { block: true as const, reason: blockedPattern.description };
    }

    const pathBlock = findBashPathBlock(command, ctx, policy.allowedWriteRoots);
    if (pathBlock) return { block: true as const, reason: pathBlock };

    const networkBlock = findNetworkBlock(command, policy.network);
    if (networkBlock) return { block: true as const, reason: networkBlock };
  }
}

function isPathInAllowedRoots(targetPath: string, ctx: UiContext, roots: CustomModePolicy["allowedWriteRoots"]): boolean {
  if (!roots || roots.length === 0) return true;
  return getAllowedRoots(ctx, roots).some((root) => targetPath === root || targetPath.startsWith(root + "/"));
}

function getAllowedRoots(ctx: UiContext, roots: CustomModePolicy["allowedWriteRoots"]): string[] {
  const cwd = resolve(ctx.cwd ?? process.cwd());
  return (roots ?? []).map((root) => {
    if (root === "cwd") return cwd;
    if (root === "parent") return resolve(cwd, "..");
    if (root.startsWith("~/")) return resolve(homedir(), root.slice(2));
    return resolve(root);
  });
}

function findBashPathBlock(command: string, ctx: UiContext, roots: CustomModePolicy["allowedWriteRoots"]): string | undefined {
  if (!roots || roots.length === 0) return;
  const allowedRoots = getAllowedRoots(ctx, roots);
  const cwd = resolve(ctx.cwd ?? process.cwd());
  const pathPattern = /(?:^|\s)(~\/?[^\s;&|]*|\.\.?\/?[^\s;&|]*|\/[^\s;&|]*)/g;
  for (const match of command.matchAll(pathPattern)) {
    const token = match[1]?.replace(/["']+$/g, "");
    if (!token || token === "." || token === ".." || token.startsWith("/-")) continue;
    if (token.startsWith("/dev/")) continue;

    const resolved = token.startsWith("~/") || token === "~"
      ? resolve(homedir(), token === "~" ? "" : token.slice(2))
      : token.startsWith("/")
        ? resolve(token)
        : resolve(cwd, token);

    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + "/"))) {
      return `Bash path blocked outside allowed roots: ${token}`;
    }
  }
}

function findCommandPatternMatch(command: string, patterns: Pattern[]): Pattern | undefined {
  return patterns.find((pattern) => {
    try {
      return new RegExp(pattern.pattern).test(command);
    } catch {
      return command.includes(pattern.pattern);
    }
  });
}

function findNetworkBlock(command: string, network: CustomModePolicy["network"]): string | undefined {
  if (!network?.allowLocalhostOnly) return;

  const urls = extractUrls(command);
  for (const url of urls) {
    if (!isAllowedLocalUrl(url, network.allowedPorts) && !isAllowedGithubReadUrl(url, network.allowGithubReadOnly)) {
      return `Network request blocked outside allowed localhost ports/GitHub read-only access: ${url}`;
    }
  }

  if (isAllowedGithubReadCommand(command, network.allowGithubReadOnly)) return;
  if (hasExternalNetworkIntent(command)) return "Network command blocked unless it targets localhost or a read-only GitHub operation.";
  if (!isNetworkCommand(command)) return;
  const localRefs = extractLocalhostRefs(command);
  if (localRefs.length === 0) return "Network command blocked unless it targets an allowed localhost port.";
  for (const ref of localRefs) {
    if (!isAllowedLocalPort(ref.port, network.allowedPorts)) {
      return `Network request blocked outside allowed localhost ports: ${ref.raw}`;
    }
  }
}

function extractUrls(command: string): string[] {
  return Array.from(command.matchAll(/https?:\/\/[^\s'"`<>]+/gi), (match) => match[0]);
}

function extractLocalhostRefs(command: string): Array<{ raw: string; port?: number }> {
  return Array.from(command.matchAll(/\b(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::(\d+))?\b/gi), (match) => ({
    raw: match[0],
    port: match[1] ? Number(match[1]) : undefined,
  }));
}

function isNetworkCommand(command: string): boolean {
  return /\b(curl|wget|http|httpie|nc|netcat|telnet|ssh|scp|rsync|gh\s+api)\b/i.test(command)
    || /\b(?:node|python|python3|ruby|perl|php|deno|bun)\b[^|;&]*(?:fetch|request|requests|urllib|http|https|socket|net\.)/i.test(command)
    || /\b(npm|pnpm|yarn|bun)\s+(install|add|view|info|search|audit|outdated|publish)\b/i.test(command)
    || /\bpip\s+install\b/i.test(command);
}

function hasExternalNetworkIntent(command: string): boolean {
  return /\b(?:ssh|scp|rsync)\s+(?!.*(?:localhost|127\.0\.0\.1|\[?::1\]?))/i.test(command)
    || /\b(?:git\s+(?:clone|fetch|pull|ls-remote)|gh\s+|npm\s+|pnpm\s+|yarn\s+|bun\s+|pip\s+)/i.test(command);
}

function isAllowedGithubReadCommand(command: string, allowGithubReadOnly?: boolean): boolean {
  if (!allowGithubReadOnly) return false;
  const trimmed = command.trim();
  return /\bgh\s+pr\s+(view|list|diff|checks|status)\b/i.test(trimmed)
    || /\bgh\s+issue\s+(view|list|status)\b/i.test(trimmed)
    || /\bgh\s+repo\s+view\b/i.test(trimmed)
    || /\bgh\s+run\s+(view|list)\b/i.test(trimmed)
    || /\bgh\s+release\s+(view|list)\b/i.test(trimmed)
    || /\bgh\s+api\b[^|;&]*\b-X\s+GET\b/i.test(trimmed)
    || /\bgit\s+(?:fetch|pull|ls-remote)\b[^|;&]*(?:github\.com[:/]|https:\/\/github\.com\/)/i.test(trimmed);
}

function isAllowedLocalUrl(rawUrl: string, allowedPorts?: number[]): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") return false;
    const port = url.port ? Number(url.port) : undefined;
    return isAllowedLocalPort(port, allowedPorts);
  } catch {
    return false;
  }
}

function isAllowedGithubReadUrl(rawUrl: string, allowGithubReadOnly?: boolean): boolean {
  if (!allowGithubReadOnly) return false;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host === "github.com" || host.endsWith(".github.com") || host === "api.github.com";
  } catch {
    return false;
  }
}

function isAllowedLocalPort(port: number | undefined, allowedPorts?: number[]): boolean {
  if (!allowedPorts || allowedPorts.length === 0) return true;
  return port !== undefined && allowedPorts.includes(port);
}

async function enforceAlwaysOnSafety(args: {
  toolName: string;
  input: Record<string, unknown>;
  ctx: UiContext;
  home: string;
  protectedPaths: string[];
  catastrophicPatterns: Pattern[];
  allowCatastrophic: boolean;
}) {
  const { toolName, input, ctx, home, protectedPaths, catastrophicPatterns, allowCatastrophic } = args;

  if (toolName === "bash") {
    const command = String(input.command ?? "");

    if (!allowCatastrophic) {
      const criticalRm = checkCriticalRmRf(command);
      if (criticalRm) {
        ctx.ui.notify(`🚫 Blocked catastrophic command: ${criticalRm}`, "error");
        return { block: true as const, reason: `Catastrophic command blocked: ${criticalRm}. This cannot be overridden.` };
      }

      const catastrophe = findMatch(command, catastrophicPatterns);
      if (catastrophe) {
        ctx.ui.notify(`🚫 Blocked catastrophic command: ${catastrophe.description}`, "error");
        return { block: true as const, reason: `Catastrophic command blocked: ${catastrophe.description}. This cannot be overridden.` };
      }
    }

    const protectedPath = protectedPaths.find((path) => command.includes(path) || command.includes(path.replace(home, "~")));
    if (protectedPath) {
      const readable = protectedPath.replace(home, "~");
      ctx.ui.notify(`🚫 Blocked bash targeting protected path: ${readable}`, "error");
      return { block: true as const, reason: `Bash command references protected path ${readable}. This cannot be overridden.` };
    }
  }

  if (toolName === "write" || toolName === "edit") {
    const targetPath = resolve(String(input.path ?? ""));
    const protectedPath = protectedPaths.find((path) => targetPath === path || targetPath.startsWith(path + "/"));
    if (protectedPath) {
      ctx.ui.notify(`🚫 Blocked write to protected path: ${targetPath}`, "error");
      return { block: true as const, reason: `Protected path blocked: ${targetPath}. This cannot be overridden.` };
    }
  }
}

function isSessionAllowed(toolName: string, input: Record<string, unknown>, sessionAllow: SessionAllow): boolean {
  if (toolName === "bash" && sessionAllow.commands.has(String(input.command ?? ""))) return true;
  return sessionAllow.tools.has(toolName);
}


function isSafePlanCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || />>/.test(trimmed) || /sed\s+.*-i/.test(trimmed)) return false;

  for (const match of trimmed.matchAll(/>/g)) {
    const idx = match.index!;
    if (idx > 0 && trimmed[idx - 1] === "2" && trimmed.slice(idx + 1).startsWith("/dev/null")) continue;
    return false;
  }

  if (["tee", "sponge", "dd"].some((cmd) => trimmed.includes(`| ${cmd}`) || trimmed.includes(`| sudo ${cmd}`))) {
    return false;
  }

  return SAFE_PLAN_BASH_PREFIXES.some((prefix) => trimmed.startsWith(prefix) || trimmed.includes(`| ${prefix}`));
}

function checkCriticalRmRf(command: string): string | null {
  for (const pattern of rmRfPatterns()) {
    const match = command.match(pattern);
    if (!match) continue;

    const home = homedir();
    const targets = match[1]!.trim().split(/\s+/).filter((target) => !target.startsWith("-"));

    for (const target of targets) {
      const resolved = resolveAbsoluteShellTarget(target, home);
      if (!resolved) continue;

      const normalized = resolved.replace(/\/+$/, "") || "/";
      if (normalized === "/") return "rm -rf / — recursive delete root";
      if (normalized === home) return "rm -rf ~ — recursive delete entire home directory";
      if (CRITICAL_DIRS.includes(normalized)) return `rm -rf ${normalized} — recursive delete critical system directory`;
    }
  }

  if (/\bsudo\s+/.test(command)) {
    const nested = checkCriticalRmRf(command.replace(/\bsudo\s+/, ""));
    if (nested) return `sudo ${nested}`;
  }

  return null;
}

function checkDangerousRmRf(command: string, cwd: string): { description: string } | null {
  for (const pattern of rmRfPatterns()) {
    const match = command.match(pattern);
    if (!match) continue;

    const rawArgs = match[1]!.trim().split(/\s*(?:&&|\|\||[;|])\s*/)[0]!;
    const targets = rawArgs.split(/\s+/).filter((target) => !target.startsWith("-") && target.length > 0);
    const normalizedCwd = resolve(cwd);

    for (const target of targets) {
      const normalized = resolveShellTarget(target, cwd);
      if (normalized === normalizedCwd || normalized.startsWith(normalizedCwd + "/")) continue;
      return { description: `recursive force delete outside project (${target})` };
    }

    return null;
  }

  return null;
}

function rmRfPatterns() {
  return [
    /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(.*)/i,
    /\brm\s+-r\s+-f\s+(.*)/i,
    /\brm\s+-f\s+-r\s+(.*)/i,
  ];
}

function resolveAbsoluteShellTarget(target: string, home = homedir()): string | null {
  if (target === "~") return home;
  if (target.startsWith("~/")) return resolve(home, target.slice(2));
  if (target === "/*") return "/";
  if (target.startsWith("/")) return target;
  return null;
}

function resolveShellTarget(target: string, cwd: string): string {
  const home = homedir();
  if (target === "~") return home;
  if (target.startsWith("~/")) return resolve(home, target.slice(2));
  if (target.startsWith("/")) return resolve(target);
  return resolve(cwd, target);
}

function findMatch(command: string, patterns: Pattern[]): Pattern | undefined {
  return patterns.find((pattern) => command.includes(pattern.pattern));
}

async function promptApproval(
  toolName: string,
  input: Record<string, unknown>,
  ctx: UiContext,
  dangerousPatterns: Pattern[],
  catastrophicPatterns: Pattern[],
  sessionAllow: SessionAllow,
  allowCatastrophic: boolean,
): Promise<{ block: true; reason: string } | undefined> {
  const { icon, description } = describeApprovalRequest(toolName, input, dangerousPatterns, catastrophicPatterns, allowCatastrophic);
  const options = [
    "Allow once",
    toolName === "bash" ? "Allow this command for session" : `Allow all ${toolName} for session`,
    "Deny",
  ];

  const choice = await ctx.ui.select(`${icon} ${description}`, options);
  if (choice === options[0]) return;

  if (choice === options[1]) {
    if (toolName === "bash") sessionAllow.commands.add(String(input.command ?? ""));
    else sessionAllow.tools.add(toolName);
    return;
  }

  return { block: true, reason: `User denied ${toolName}` };
}

function describeApprovalRequest(
  toolName: string,
  input: Record<string, unknown>,
  dangerousPatterns: Pattern[],
  catastrophicPatterns: Pattern[],
  allowCatastrophic: boolean,
): { icon: string; description: string } {
  if (toolName === "write") return { icon: "🔒", description: `write: ${input.path}` };
  if (toolName === "edit") return { icon: "🔒", description: `edit: ${input.path}` };
  if (toolName !== "bash") return { icon: "🔒", description: toolName };

  const command = String(input.command ?? "");
  const catastrophe = allowCatastrophic ? undefined : findMatch(command, catastrophicPatterns);
  const danger = findMatch(command, dangerousPatterns);
  const rmDanger = checkDangerousRmRf(command, process.cwd());

  if (catastrophe) return { icon: "🚫", description: `bash: ${command}\n   🚫 CATASTROPHIC: ${catastrophe.description}` };
  if (danger) return { icon: "⚠️", description: `bash: ${command}\n   ⚠️  DANGEROUS: ${danger.description}` };
  if (rmDanger) return { icon: "⚠️", description: `bash: ${command}\n   ⚠️  DANGEROUS: ${rmDanger.description}` };
  return { icon: "🔒", description: `bash: ${command}` };
}
