/**
 * Plannotator Wrapper Extension
 *
 * Provides:
 *   execute-plan — command for clean-session start after approval
 *
 * POST-APPROVAL FLOW:
 *   1. plannotator_submit_plan (from @plannotator/pi-extension) emits
 *      "plannotator:new-session-approved" synchronously before returning.
 *   2. This file's listener stores filePath + planContent in pendingSession.
 *   3. "plannotator-wrapper:plan-approved" is emitted to suppress @plannotator's
 *      in-place continueWhenIdle fallback (prevents an unwanted in-session LLM turn).
 *   4. A ui.select prompt asks the user: new session or same session.
 *   5a. New session: ctx.ui.setEditorText("/execute-plan") pre-fills the editor.
 *       The user presses Enter → the command handler fires with a real
 *       ExtensionCommandContext → launchPlanSession() starts the new session.
 *   5b. Same session: "plannotator-wrapper:execute-same-session" is emitted.
 *
 * WHY THE EVENT HANDLER CANNOT CALL ctx.newSession() DIRECTLY:
 *   session_start delivers ExtensionContext, which does NOT include newSession().
 *   Only ExtensionCommandContext (given to registerCommand handlers) has it.
 *   Casting ExtensionContext as ExtensionCommandContext silently no-ops — the
 *   method is undefined at runtime, so the call does nothing and the session
 *   stays idle. This is the same reason the handoff extension keeps all ctx.newSession()
 *   calls inside its registerCommand handler, never in event handlers.
 *
 * WHY sendUserMessage("/command") DOESN'T TRIGGER COMMAND HANDLERS:
 *   sendUserMessage internally calls prompt(text, { expandPromptTemplates: false }).
 *   The command check in agent-session.js is gated on
 *   `expandPromptTemplates && text.startsWith("/")` — always false from sendUserMessage.
 *   Commands only fire reliably via interactive user input (expandPromptTemplates: true).
 *   setEditorText("/execute-plan") + user pressing Enter goes through the interactive
 *   path and reliably fires the command handler.
 */

import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export default function plannotatorWrapper(pi: ExtensionAPI): void {
	// Holds plan data between event listener and manual /execute-plan command.
	// Set by plannotator:new-session-approved listener.
	// Consumed by the command handler (manual new-session flow).
	let pendingSession: {
		filePath: string | null;
		planContent: string | null;
	} | null = null;
	// Captured from session_start so the event handler can show UI
	let sessionCtx: ExtensionContext | null = null;

	// ── Capture ctx for use in event handlers ─────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
	});

	// ── Shared new-session launcher ─────────────────────────────────────────
	//
	// Called exclusively from the /execute-plan command handler, which receives
	// a real ExtensionCommandContext with a working newSession() method.
	// Mirrors the pattern used by the handoff extension: all ctx.newSession() calls live
	// inside registerCommand handlers, never in event handlers.

	async function launchPlanSession(
		ctx: ExtensionCommandContext,
		pending: { filePath: string | null; planContent: string | null },
	): Promise<void> {
		const { filePath, planContent } = pending;
		const sessionTitle = filePath
			? `Executing: ${basename(filePath)}`
			: "Executing approved plan";
		const hasTodos =
			planContent != null && /^[-*]\s+\[[ x]\]/m.test(planContent);
		const doneHint = hasTodos
			? " After completing each step, include [DONE:n] in your response where n is the step number."
			: "";

		await ctx.newSession({
			setup: async (sm) => {
				sm.appendSessionInfo(sessionTitle);
			},
			withSession: async (replacementCtx) => {
				if (planContent) {
					await replacementCtx.sendMessage(
						{
							customType: "plan-approved-execute",
							content: `## Approved Plan\n\nThe following plan was reviewed and approved. Execute it.\n\n${planContent}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
				const msg = planContent
					? `Continue with the approved plan above. Execute each step in order.${doneHint}`
					: `Continue with the approved plan.${doneHint}`;
				await replacementCtx.sendUserMessage(msg.trim());
			},
		});
	}

	// ── /execute-plan command ─────────────────────────────────────────────────
	//
	// This is the ONLY place that calls launchPlanSession() / ctx.newSession().
	// Interactive user input uses expandPromptTemplates: true, which routes
	// through _tryExecuteExtensionCommand → createCommandContext() and gives
	// a real ExtensionCommandContext with newSession() available.
	//
	// The post-approval event handler pre-fills the editor with "/execute-plan"
	// (via ctx.ui.setEditorText) so the user just presses Enter — no typing needed.
	// pendingSession survives until consumed here (or overwritten by a new approval).

	pi.registerCommand("execute-plan", {
		description:
			"Start a clean new build-mode session with the approved plan pre-seeded. " +
			"Automatically triggered after plan approval (editor pre-filled). " +
			"Can also be typed manually after approving a plan.",
		handler: async (_args, ctx) => {
			const pending = pendingSession;
			pendingSession = null;
			if (!pending) {
				ctx.ui.notify(
					"No pending plan. Approve a plan first, then type /execute-plan.",
					"warning",
				);
				return;
			}

			await launchPlanSession(ctx, pending);
		},
	});

	// ── plannotator:new-session-approved listener ─────────────────────────────
	//
	// Fired by plan-utils.ts plan_submit tool when the user chooses "new session"
	// after approval. Stores pendingSession and pre-fills the editor so the user
	// just presses Enter to trigger the /execute-plan command handler.

	pi.events.on("plannotator:new-session-approved", async (data: unknown) => {
		const { filePath = null, planContent: content = null } =
			(data as { filePath?: string | null; planContent?: string | null }) ?? {};

		pendingSession = { filePath, planContent: content };

		const ctx = sessionCtx;
		ctx?.ui?.setEditorText?.("/execute-plan");
		ctx?.ui?.notify?.(
			"Press Enter to start a clean new session with the approved plan.",
			"info",
		);
	});
}
