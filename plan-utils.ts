/**
 * plan-utils Extension
 *
 * Provides lean plan tools:
 *   plan_save   — saves plan markdown to ~/.pi/plans/<project>/<date>/<slug>.md
 *                 (or to a custom cwd directory)
 *   plan_submit — opens a file in plannotator browser UI (via CLI), waits for
 *                 approve/deny/feedback, returns the result to the LLM.
 *   annotate    — alias for plan_submit, used to display and annotate markdown
 *                 files (or any file plannotator can open).
 *
 * No heavy event wiring. No new-session logic. Just save → review → continue.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { execSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export default function planUtils(pi: ExtensionAPI): void {
	// ── Helpers ───────────────────────────────────────────────────────────────

	const DEFAULT_PLANS_DIR = join(homedir(), ".pi", "plans");

	function derivePlanPath(
		content: string,
		cwd: string,
		hint?: string,
		targetDir?: string,
	): string {
		const plansRoot = targetDir ? resolve(targetDir) : DEFAULT_PLANS_DIR;
		const cwdSanitized = targetDir
			? ""
			: cwd.replace(/^\//, "").replace(/\//g, "-") || "root";
		const date = new Date().toISOString().slice(0, 10);

		let slug: string;
		if (hint) {
			slug = basename(hint).replace(/\.(md|mdx)$/i, "");
		} else {
			const headingMatch = content.match(/^#+\s+(.+)/m);
			const source = headingMatch
				? headingMatch[1]
				: content.trim().split("\n")[0];
			slug =
				source
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+| -+$/g, "")
					.slice(0, 60) || "plan";
		}

		return targetDir
			? join(plansRoot, date, `${slug}.md`)
			: join(plansRoot, cwdSanitized, date, `${slug}.md`);
	}

	function resolveWorkingPath(
		inputPath: string,
		ctxCwd: string,
		cwdParam?: string,
	): string {
		const base = cwdParam ? resolve(ctxCwd, cwdParam) : ctxCwd;
		return resolve(base, inputPath);
	}

	function findPlannotator(): string | null {
		try {
			return execSync("which plannotator", { encoding: "utf-8" }).trim();
		} catch {
			return null;
		}
	}

	// ── plan_save tool ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "plan_save",
		label: "Save Plan",
		description:
			"Write a plan to ~/.pi/plans/<project>/<date>/<slug>.md by default, " +
			"or to <cwd>/<date>/<slug>.md when cwd is provided. " +
			"Returns the absolute file path. Call plan_submit next to open the review UI.",
		promptSnippet: "Save plan markdown → returns file path for plan_submit",
		parameters: {
			type: "object" as const,
			properties: {
				content: {
					type: "string",
					description: "Full markdown content of the plan.",
				},
				filename: {
					type: "string",
					description:
						"Optional slug hint for the filename (e.g. 'auth-refactor'). " +
						"If omitted, derived from the first heading.",
				},
				cwd: {
					type: "string",
					description:
						"Optional target directory for the plan. " +
						"If omitted, the plan is saved under ~/.pi/plans/<project>/<date>.",
				},
			},
			required: ["content"],
		},
		async execute(
			_toolCallId: string,
			params: { content?: string; filename?: string; cwd?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const rawContent = (params?.content ?? "").trim();
			if (!rawContent) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: content is required and must not be empty.",
						},
					],
					details: undefined,
				};
			}

			const fullPath = derivePlanPath(
				rawContent,
				ctx.cwd,
				params?.filename,
				params?.cwd,
			);
			const dir = dirname(fullPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(fullPath, rawContent, "utf-8");

			return {
				content: [
					{
						type: "text" as const,
						text: `Plan saved to \`${fullPath}\`.\nCall plan_submit with filePath: "${fullPath}" to open the review UI.`,
					},
				],
				details: undefined,
			};
		},
	});

	// ── plan_submit tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "plan_submit",
		label: "Submit Plan for Review",
		description:
			"Open a file in the Plannotator browser UI for human review. " +
			"Blocks until the user approves, denies with feedback, or dismisses. " +
			"Returns the decision and any feedback annotations.",
		promptSnippet:
			"Open plan in browser for approval → returns decision + feedback",
		parameters: {
			type: "object" as const,
			properties: {
				filePath: {
					type: "string",
					description:
						"Path to the file to review. Absolute paths are used as-is; " +
						"relative paths are resolved against cwd (or ctx.cwd if cwd is omitted).",
				},
				cwd: {
					type: "string",
					description:
						"Optional base directory for resolving a relative filePath.",
				},
			},
			required: ["filePath"],
		},
		async execute(
			_toolCallId: string,
			params: { filePath?: string; cwd?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return submitPlan(params?.filePath ?? "", params?.cwd, ctx);
		},
	});

	// ── annotate tool (alias for plan_submit) ─────────────────────────────────

	pi.registerTool({
		name: "annotate",
		label: "Annotate File",
		description:
			"Display and annotate a markdown file (or any file plannotator can open) " +
			"in the Plannotator browser UI. Alias for plan_submit; accepts the same " +
			"filePath and optional cwd parameters.",
		promptSnippet:
			"Display/annotate a file in browser → returns decision + feedback",
		parameters: {
			type: "object" as const,
			properties: {
				filePath: {
					type: "string",
					description:
						"Path to the file to annotate. Absolute paths are used as-is; " +
						"relative paths are resolved against cwd (or ctx.cwd if cwd is omitted).",
				},
				cwd: {
					type: "string",
					description:
						"Optional base directory for resolving a relative filePath.",
				},
			},
			required: ["filePath"],
		},
		async execute(
			_toolCallId: string,
			params: { filePath?: string; cwd?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return submitPlan(params?.filePath ?? "", params?.cwd, ctx);
		},
	});

	// ── Shared submission logic ───────────────────────────────────────────────

	async function submitPlan(
		inputPath: string,
		cwdParam: string | undefined,
		ctx: ExtensionContext,
	) {
		const trimmedPath = inputPath.trim();
		if (!trimmedPath) {
			return {
				content: [
					{ type: "text" as const, text: "Error: filePath is required." },
				],
				details: undefined,
			};
		}

		const fullPath = resolveWorkingPath(trimmedPath, ctx.cwd, cwdParam);

		// Validate file exists and is readable
		try {
			if (!statSync(fullPath).isFile()) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${fullPath} is not a regular file.`,
						},
					],
					details: undefined,
				};
			}
		} catch {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: ${fullPath} does not exist.`,
					},
				],
				details: undefined,
			};
		}

		const planContent = readFileSync(fullPath, "utf-8").trim();
		if (!planContent) {
			return {
				content: [{ type: "text" as const, text: "Error: file is empty." }],
				details: undefined,
			};
		}

		// Check plannotator CLI is available
		const plannotatorBin = findPlannotator();
		if (!plannotatorBin) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: `plannotator` CLI not found in PATH. Install it: curl -fsSL https://plannotator.ai/install.sh | bash",
					},
				],
				details: undefined,
			};
		}

		// Open plan in plannotator browser UI with annotate --gate (shows Approve + Send Feedback)
		ctx.ui?.notify("Opening file in browser for review...", "info");

		try {
			const output = await new Promise<string>((res, rej) => {
				const child = spawn(
					plannotatorBin,
					["annotate", fullPath, "--gate", "--json"],
					{
						stdio: ["pipe", "pipe", "pipe"],
					},
				);

				let stdout = "";
				let stderr = "";
				child.stdout?.on("data", (d: Buffer) => {
					stdout += d.toString();
				});
				child.stderr?.on("data", (d: Buffer) => {
					stderr += d.toString();
				});

				child.on("error", rej);
				child.on("close", (code) => {
					if (code !== 0 && !stdout.trim()) {
						rej(
							new Error(
								stderr.trim() || `plannotator exited with code ${code}`,
							),
						);
					} else {
						res(stdout);
					}
				});

				child.stdin?.end();

				// 10 min timeout
				setTimeout(() => {
					child.kill();
					rej(new Error("TIMEOUT"));
				}, 600_000);
			});

			const trimmed = output.trim();
			if (!trimmed) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Review dismissed. The user closed the review UI without taking action.",
						},
					],
					details: { approved: false, dismissed: true } as any,
				};
			}

			// --json outputs: {"decision":"approved|dismissed|annotated", "feedback":"..."}
			let decision: { decision: string; feedback?: string };
			try {
				decision = JSON.parse(trimmed);
			} catch {
				// Non-JSON fallback: treat as plain feedback
				return {
					content: [
						{
							type: "text" as const,
							text: `Review feedback:\n\n${trimmed}\n\nRevise and resubmit.`,
						},
					],
					details: { approved: false, feedback: trimmed } as any,
				};
			}

			if (decision.decision === "approved") {
				// Ask the user how to proceed
				const choice = await ctx.ui?.select?.(
					"✅ Review approved — how do you want to proceed?",
					[
						"▶️  Same session — switch to build mode and continue here",
						"🆕 New session — start a clean session with the file pre-seeded",
					],
				);

				if (choice?.startsWith("🆕")) {
					// New-session path: hand off to execute-plan.ts via event
					pi.events.emit("plannotator:new-session-approved", {
						filePath: fullPath,
						planContent,
					});
					return {
						content: [
							{
								type: "text" as const,
								text:
									"✅ Review approved — new session selected. " +
									"The editor has been pre-filled with /execute-plan. " +
									"Press Enter to launch a clean session with the content pre-seeded.",
							},
						],
						details: { approved: true, newSession: true } as any,
					};
				}

				// Same-session path: emit mode-change event; content goes back to LLM via tool result
				pi.events.emit("plannotator-wrapper:execute-same-session", {
					planContent,
					modeChangeOnly: true,
				});
				const hasTodos = /^[-*]\s+\[[ x]\]/m.test(planContent);
				const doneHint = hasTodos
					? "\n\nAfter completing each step, include [DONE:n] in your response where n is the step number."
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `✅ Review approved! Build mode restored. Execute the plan steps in order. Use todos to track progress.${doneHint}\n\n## Approved Content\n\n${planContent}`,
						},
					],
					details: { approved: true, sameSession: true } as any,
				};
			}

			if (decision.decision === "annotated" && decision.feedback) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Review feedback:\n\n${decision.feedback}\n\n` +
								"Revise based on the feedback above, save with plan_save, and submit again.",
						},
					],
					details: { approved: false, feedback: decision.feedback } as any,
				};
			}

			// dismissed or unknown
			return {
				content: [
					{
						type: "text" as const,
						text: "Review dismissed without approval. Ask the user how to proceed.",
					},
				],
				details: { approved: false, dismissed: true } as any,
			};
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("TIMEOUT")) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Review timed out (10 min). Ask the user to review.",
						},
					],
					details: undefined,
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Error opening review: ${msg}`,
					},
				],
				details: undefined,
			};
		}
	}
}
