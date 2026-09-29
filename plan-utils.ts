/**
 * plan-utils Extension
 *
 * Provides lean plan tools:
 *   plan_save   — saves plan markdown to ~/.pi/plans/<project>/<date>/<slug>.md
 *                 (or to a custom cwd directory)
 *   plan_submit — opens a file, or a folder of Markdown files, for human
 *                 review. Inside Herdr (see
 *                 checkTuiPreconditions) it runs `plannotator-tui herdr open`
 *                 and returns at once with text starting
 *                 `Review opened in plannotator-tui`, telling the model to end
 *                 its turn; the feedback arrives as the next user message.
 *                 Otherwise it runs the Plannotator browser gate and returns
 *                 the decision.
 *   annotate    — alias for plan_submit.
 *   Backend: planTools.reviewBackend (auto | tui | browser) in the profile settings.json, re-read per call.
 *
 * No event wiring, no session hand-off, no dialogs.
 */

import {
	type Dirent,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export default function planUtils(pi: ExtensionAPI): void {
	// ── Types ─────────────────────────────────────────────────────────────────

	type ReviewDetails = {
		backend: "tui" | "browser";
		approved?: boolean;
		dismissed?: boolean;
		feedback?: string;
		paneId?: string;
		filePath?: string;
		isFolder?: boolean;
		fallbackReason?: string;
	};
	type ReviewResult = {
		content: { type: "text"; text: string }[];
		details: ReviewDetails | undefined;
	};
	type BackendChoice =
		| { backend: "tui"; tuiBin: string }
		| { backend: "browser"; fallbackReason?: string };

	type ReviewBackendSetting = "auto" | "tui" | "browser";

	const TUI_MARKER = "Review opened in plannotator-tui";

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

	const MARKDOWN_EXT = /\.(md|mdx|markdown)$/i;

	/**
	 * True when `dir` holds a Markdown file within `depth` levels below it.
	 * Dot-prefixed subfolders are skipped, matching the folder view's default tree.
	 */
	function hasMarkdown(dir: string, depth: number): boolean {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		if (entries.some((e) => e.isFile() && MARKDOWN_EXT.test(e.name)))
			return true;
		if (depth <= 0) return false;
		return entries.some(
			(e) =>
				e.isDirectory() &&
				!e.name.startsWith(".") &&
				hasMarkdown(join(dir, e.name), depth - 1),
		);
	}

	function findBin(name: string): string | null {
		try {
			return (
				execFileSync("which", [name], {
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim() || null
			);
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
			"Open a file, or a folder of Markdown files, for human review. A folder opens " +
			"with a file tree and yields one combined review across its files. " +
			"Depending on configuration and environment, " +
			"the review opens either in plannotator-tui inside a Herdr pane (returns " +
			"immediately; follow the result and end your turn, the feedback arrives as " +
			"the next user message) or in the Plannotator browser gate (blocks until the " +
			"user approves, sends feedback, or dismisses). Act on the returned text.",
		promptSnippet:
			"Open a file or folder for human review → TUI hand-off (end your turn) or browser decision + feedback",
		parameters: {
			type: "object" as const,
			properties: {
				filePath: {
					type: "string",
					description:
						"Path to the file, or folder of Markdown files, to review. Absolute paths are used as-is; " +
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
			"Display and annotate a markdown file (or any file plannotator can open), " +
			"or a folder of Markdown files as one combined review, " +
			"for human review. Alias for plan_submit: same filePath and optional cwd " +
			"parameters, same backends (plannotator-tui in a Herdr pane, or the " +
			"Plannotator browser gate). Act on the returned text.",
		promptSnippet:
			"Display/annotate a file or folder for human review → TUI hand-off (end your turn) or browser decision + feedback",
		parameters: {
			type: "object" as const,
			properties: {
				filePath: {
					type: "string",
					description:
						"Path to the file, or folder of Markdown files, to annotate. Absolute paths are used as-is; " +
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
	): Promise<ReviewResult> {
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

		// Validate the path exists and is a regular file or a folder
		let isFolder: boolean;
		try {
			const st = statSync(fullPath);
			isFolder = st.isDirectory();
			if (!isFolder && !st.isFile()) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${fullPath} is not a regular file or folder.`,
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

		if (isFolder) {
			if (!hasMarkdown(fullPath, 2)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: folder ${fullPath} has no Markdown files within two levels.`,
						},
					],
					details: undefined,
				};
			}
		} else {
			const planContent = readFileSync(fullPath, "utf-8").trim();
			if (!planContent) {
				return {
					content: [{ type: "text" as const, text: "Error: file is empty." }],
					details: undefined,
				};
			}
		}

		const choice = chooseBackend(ctx);
		let fallbackReason: string | undefined;
		if (choice.backend === "tui") {
			const tui = await runTuiReview(choice.tuiBin, fullPath, isFolder);
			if (tui.ok) return tui.result;
			fallbackReason = tui.reason;
		} else {
			fallbackReason = choice.fallbackReason;
		}
		const browser = await runBrowserReview(fullPath, isFolder, ctx);
		return fallbackReason ? withFallbackNote(browser, fallbackReason) : browser;
	}

	// ── Backend selection ─────────────────────────────────────────────────────

	function checkTuiPreconditions(
		ctx: ExtensionContext,
	): { ok: true; tuiBin: string } | { ok: false; reason: string } {
		if (process.env.HERDR_ENV !== "1") {
			return { ok: false, reason: "HERDR_ENV is not 1" };
		}
		if (!process.env.HERDR_PANE_ID?.trim()) {
			return { ok: false, reason: "HERDR_PANE_ID is not set" };
		}
		if (process.env.PI_SUBAGENT_CHILD) {
			return {
				ok: false,
				reason: "running as a subagent child (PI_SUBAGENT_CHILD is set)",
			};
		}
		if (!ctx.hasUI) {
			return { ok: false, reason: "no interactive UI (ctx.hasUI is false)" };
		}
		const tuiBin = findBin("plannotator-tui");
		if (!tuiBin) {
			return { ok: false, reason: "plannotator-tui not found on PATH" };
		}
		return { ok: true, tuiBin };
	}

	/** Profile settings.json path from PI_CODING_AGENT_DIR (pi-herdr-hooks pattern). */
	function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
		const dir = env.PI_CODING_AGENT_DIR;
		if (!dir) return join(homedir(), ".pi", "agent", "settings.json");
		if (dir === "~") return join(homedir(), "settings.json");
		if (dir.startsWith("~/"))
			return join(homedir(), dir.slice(2), "settings.json");
		return join(dir, "settings.json");
	}

	/** planTools.reviewBackend; missing file/block, bad JSON or unknown value ⇒ "auto". */
	function readReviewBackend(): ReviewBackendSetting {
		try {
			const parsed: unknown = JSON.parse(
				readFileSync(resolveSettingsPath(), "utf8"),
			);
			if (!isObject(parsed)) return "auto";
			const planTools = parsed.planTools;
			if (!isObject(planTools)) return "auto";
			const value = planTools.reviewBackend;
			return value === "auto" || value === "tui" || value === "browser"
				? value
				: "auto";
		} catch {
			return "auto";
		}
	}

	function chooseBackend(ctx: ExtensionContext): BackendChoice {
		// Backend from planTools.reviewBackend (re-read per call; invalid ⇒ auto).
		const setting = readReviewBackend();
		if (setting === "browser") return { backend: "browser" };
		// "auto" and "tui" behave identically today (D10).
		const pre = checkTuiPreconditions(ctx);
		return pre.ok
			? { backend: "tui", tuiBin: pre.tuiBin }
			: { backend: "browser", fallbackReason: pre.reason };
	}

	function withFallbackNote(result: ReviewResult, reason: string): ReviewResult {
		const [first, ...rest] = result.content;
		const note = `plannotator-tui unavailable (${reason}); used the browser review instead.`;
		const content = first
			? [{ ...first, text: `${note}\n\n${first.text}` }, ...rest]
			: [{ type: "text" as const, text: note }];
		return {
			content,
			details: {
				...(result.details ?? { backend: "browser" }),
				fallbackReason: reason,
			},
		};
	}

	// ── plannotator-tui backend (Herdr) ───────────────────────────────────────

	function firstNonEmptyLine(text: string): string | undefined {
		return text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0);
	}

	function parseJson(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}

	function isObject(x: unknown): x is Record<string, unknown> {
		return typeof x === "object" && x !== null && !Array.isArray(x);
	}

	function runTuiReview(
		tuiBin: string,
		fullPath: string,
		isFolder: boolean,
	): Promise<{ ok: true; result: ReviewResult } | { ok: false; reason: string }> {
		return new Promise((res) => {
			execFile(
				tuiBin,
				["herdr", "open", fullPath],
				{ encoding: "utf-8", timeout: 15_000 },
				(err, stdout, stderr) => {
					if (err) {
						if (err.killed) {
							res({ ok: false, reason: "herdr open timed out after 15s" });
							return;
						}
						const detail =
							firstNonEmptyLine(String(stderr ?? "")) ??
							(typeof err.code === "number"
								? `exit code ${err.code}`
								: (firstNonEmptyLine(err.message) ?? "unknown error"));
						res({ ok: false, reason: `herdr open failed: ${detail}` });
						return;
					}

					const out = String(stdout ?? "").trim();
					let parsed = parseJson(out);
					if (parsed === undefined) {
						const lines = out
							.split("\n")
							.map((l) => l.trim())
							.filter((l) => l.length > 0);
						const last = lines[lines.length - 1];
						if (last !== undefined) parsed = parseJson(last);
					}
					const result = isObject(parsed) ? parsed.result : undefined;
					const pluginPane = isObject(result) ? result.plugin_pane : undefined;
					if (!isObject(pluginPane)) {
						res({ ok: false, reason: "herdr open returned unexpected output" });
						return;
					}

					const pane = pluginPane.pane;
					const nestedId = isObject(pane) ? pane.pane_id : undefined;
					const paneId =
						typeof nestedId === "string" && nestedId
							? nestedId
							: typeof pluginPane.pane_id === "string" && pluginPane.pane_id
								? pluginPane.pane_id
								: "unknown";

					res({
						ok: true,
						result: {
							content: [
								{
									type: "text",
									text:
										`${TUI_MARKER}: pane ${paneId}, ${isFolder ? "folder" : "file"} ${fullPath}.\n` +
										"End your turn now. Do not wait, poll, or read the review pane. " +
										"The human's feedback (or a go-ahead) arrives as the next user " +
										"message; address every item, then continue.",
								},
							],
							details: isFolder
								? { backend: "tui", paneId, filePath: fullPath, isFolder }
								: { backend: "tui", paneId, filePath: fullPath },
						},
					});
				},
			);
		});
	}

	// ── Plannotator browser gate ──────────────────────────────────────────────

	async function runBrowserReview(
		fullPath: string,
		isFolder: boolean,
		ctx: ExtensionContext,
	): Promise<ReviewResult> {
		// Check plannotator CLI is available
		const plannotatorBin = findBin("plannotator");
		if (!plannotatorBin) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: `plannotator` CLI not found in PATH. Install it: curl -fsSL https://plannotator.ai/install.sh | bash",
					},
				],
				details: { backend: "browser" },
			};
		}

		// Open plan in plannotator browser UI with annotate --gate (shows Approve + Send Feedback)
		ctx.ui?.notify(
			`Opening ${isFolder ? "folder" : "file"} in browser for review...`,
			"info",
		);
		// `plannotator annotate` spells a folder argument as `folder/`.
		const target =
			isFolder && !fullPath.endsWith(sep) ? `${fullPath}${sep}` : fullPath;

		try {
			const output = await new Promise<string>((res, rej) => {
				const child = spawn(
					plannotatorBin,
					["annotate", target, "--gate", "--json"],
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
					details: { backend: "browser", approved: false, dismissed: true },
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
					details: { backend: "browser", approved: false, feedback: trimmed },
				};
			}

			if (decision.decision === "approved") {
				const feedback =
					typeof decision.feedback === "string" ? decision.feedback.trim() : "";
				return {
					content: [
						{
							type: "text" as const,
							text: feedback
								? `Review approved. Feedback:\n\n${feedback}`
								: "Review approved.",
						},
					],
					details: feedback
						? { backend: "browser", approved: true, feedback }
						: { backend: "browser", approved: true },
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
					details: {
						backend: "browser",
						approved: false,
						feedback: decision.feedback,
					},
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
				details: { backend: "browser", approved: false, dismissed: true },
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
					details: { backend: "browser" },
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Error opening review: ${msg}`,
					},
				],
				details: { backend: "browser" },
			};
		}
	}
}
