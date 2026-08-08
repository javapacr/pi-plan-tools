/**
 * Plannotator Integration Layer
 *
 * Augments @zackify/pi-claude-permissions plan mode with the plannotator
 * workflow: explore -> save plan -> submit for review -> approve ->
 * switch back to build mode and execute.
 *
 * This extension owns NO mode state of its own. @zackify is the single source
 * of truth for permission mode (shows its own status in the footer).
 *
 * Cross-extension mode change:
 *   Emits "pi-claude-permissions:set-mode" which @zackify listens for
 *   (small patch in its index.ts) -- used by plannotator_exit_plan and
 *   the same-session handler to exit plan mode before running the plan.
 *
 * Plan mode detection:
 *   @zackify emits "pi-claude-permissions:mode-changed" whenever applyMode()
 *   runs (Shift+Tab, set-mode event, session_start). We listen here and track
 *   the current mode explicitly -- no tool-set inference needed.
 *

 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function readSettingsJson(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function readPlanModeInstructions(): string {
	// Resolve path from settings.json (project-local overrides global)
	type EnhancerConfig = { planModeInstructionsPath?: string };
	const global = readSettingsJson(
		join(homedir(), ".pi", "agent", "settings.json"),
	);
	const local = readSettingsJson(join(process.cwd(), ".pi", "settings.json"));
	const configuredPath =
		(local.plannotatorEnhancer as EnhancerConfig | undefined)
			?.planModeInstructionsPath ??
		(global.plannotatorEnhancer as EnhancerConfig | undefined)
			?.planModeInstructionsPath;

	if (!configuredPath) return "";

	const resolved = configuredPath.startsWith("~/")
		? join(homedir(), configuredPath.slice(2))
		: configuredPath;

	try {
		return readFileSync(resolved, "utf-8").trim();
	} catch {
		return "";
	}
}

function readPlanModeAllowedTools(): string[] {
	try {
		const permissionsPath = join(
			homedir(),
			".pi",
			"agent",
			"extensions",
			"permissions.json",
		);
		const config = JSON.parse(readFileSync(permissionsPath, "utf-8")) as {
			planModeAllowedTools?: string[];
		};
		return config.planModeAllowedTools ?? [];
	} catch {
		return [];
	}
}

// The permission mode to restore when exiting plan mode.
const DEFAULT_BUILD_MODE = "bypassPermissions";

export default function plannotatorIntegration(pi: ExtensionAPI): void {
	// Track @zackify's current permission mode via the event it emits on every
	// applyMode() call. Starts as null (unknown) until the first event arrives.
	let zackifyMode: string | null = null;

	// Track the permission mode that was active immediately before plan mode was
	// entered. Used to restore the right mode when executing in the same session
	// after plan approval — rather than always jumping to bypassPermissions.
	let prePlanMode: string | null = null;

	pi.events.on("pi-claude-permissions:mode-changed", (data: unknown) => {
		const { mode } = (data as { mode?: string }) ?? {};
		if (mode) {
			const wasPlan = zackifyMode === "plan";
			// Capture the mode we're leaving whenever plan mode is being entered.
			if (mode === "plan" && !wasPlan) {
				prePlanMode = zackifyMode;
			}
			zackifyMode = mode;
		}
	});

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	/** True when @zackify is in its "plan" permission mode. */
	function isInZackifyPlanMode(): boolean {
		return zackifyMode === "plan";
	}

	/** Emit cross-extension event asking @zackify to change its permission mode. */
	function requestModeChange(mode: string): void {
		pi.events.emit("pi-claude-permissions:set-mode", { mode });
	}

	// ---------------------------------------------------------------------------
	// Message renderers
	// ---------------------------------------------------------------------------

	pi.registerMessageRenderer(
		"plan-approved-execute",
		(message, _options, theme) => {
			const content =
				typeof message.content === "string" ? message.content : "";
			const header = theme.fg("accent", "\u2705 Approved Plan\n");
			const match = content.match(/Execute it\.\n\n([\s\S]*)$/);
			const body = match ? match[1].trim() : content;
			return new Text(header + theme.fg("muted", body), 0, 0);
		},
	);

	pi.registerMessageRenderer(
		"plan-approved-start",
		(message, _options, theme) => {
			const content =
				typeof message.content === "string" ? message.content : "";
			return new Text(theme.fg("dim", "\u25b6 " + content), 0, 0);
		},
	);

	// ---------------------------------------------------------------------------
	// ---------------------------------------------------------------------------
	// plannotator_exit_plan -- LLM-callable tool
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "plannotator_exit_plan",
		label: "Exit Plan Mode",
		description:
			"Exit plan mode and return to build mode with full tool access. " +
			"Use this for a same-session exit (e.g. the user asks to stop planning). " +
			"Note: when plan_submit is approved, the extension automatically " +
			"switches to build mode -- no need to call this tool in that flow.",
		promptSnippet: "Exit plan mode -> build mode (same session)",
		parameters: {
			type: "object" as const,
			properties: {
				reason: {
					type: "string",
					description: "Why plan mode is being exited. Optional.",
				},
			},
		},
		async execute(
			_toolCallId: string,
			params: { reason?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		) {
			if (!isInZackifyPlanMode()) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Already in build mode -- no change needed.",
						},
					],
					details: undefined,
				};
			}
			requestModeChange(prePlanMode ?? DEFAULT_BUILD_MODE);
			const msg = params?.reason
				? `Exited plan mode: ${params.reason}. Full tool access restored.`
				: "Exited plan mode. Full tool access restored.";
			return {
				content: [{ type: "text" as const, text: msg }],
				details: undefined,
			};
		},
	});

	// ---------------------------------------------------------------------------
	// Inject plannotator tools + instructions when in plan mode
	// ---------------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		if (!isInZackifyPlanMode()) {
			return {};
		}

		// Restore plan-mode tools that @zackify removed from the active set.
		// Source of truth: planModeAllowedTools in permissions.json.
		const current = pi.getActiveTools();
		const allToolNames = pi.getAllTools().map((t) => t.name);
		const toAdd = readPlanModeAllowedTools().filter(
			(name) => allToolNames.includes(name) && !current.includes(name),
		);
		if (toAdd.length > 0) {
			pi.setActiveTools([...current, ...toAdd]);
		}

		// Inject plan-mode instructions into the system prompt.
		// Rebuilt fresh every turn — zero session history accumulation.
		const planInstructions = readPlanModeInstructions();
		if (!planInstructions) return {};
		return {
			systemPrompt: event.systemPrompt + "\n\n" + planInstructions,
		};
	});

	// ---------------------------------------------------------------------------
	// Same-session execution after plan approval
	// ---------------------------------------------------------------------------

	pi.events.on("plannotator-wrapper:execute-same-session", (data: unknown) => {
		const payload =
			(data as { planContent?: string | null; modeChangeOnly?: boolean }) ?? {};
		// Restore the mode that was active before plan mode was entered.
		requestModeChange(prePlanMode ?? "acceptEdits");

		// When modeChangeOnly is set (emitted by plan-utils.ts plan_submit),
		// the plan content is already in the tool result going back to the LLM.
		// Skip sendMessage to avoid a redundant second LLM turn.
		if (payload.modeChangeOnly) return;

		// Legacy path: handle execute-same-session emitted by older callers
		// that don't embed plan content in the tool result.
		const { planContent } = payload;
		if (!planContent) return;

		const hasTodos = /^[-*]\s+\[[ x]\]/m.test(planContent);
		const doneHint = hasTodos
			? " After completing each step, include [DONE:n] in your response where n is the step number."
			: "";

		pi.sendMessage(
			{
				customType: "plan-approved-execute",
				content: `## Approved Plan\n\nThe following plan was reviewed and approved. Execute it.\n\n${planContent}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		pi.sendMessage(
			{
				customType: "plan-approved-start",
				content: `Continue with the approved plan above. Execute each step in order.${doneHint}`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});
}
