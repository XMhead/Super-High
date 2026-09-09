import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

/**
 * One-shot resume driver: load a persisted DSH session, deliver one
 * continuation prompt, wait for the turn to settle, print the final assistant
 * text, and exit with the same exit-code contract as dsh-headless.
 *
 * Used to recover sessions whose process was killed mid-turn (e.g. the PTY
 * owner was replaced) without losing the durable step history.
 *
 * @module @dsh-external/dsh-resume-runner
 */
const name = "resume-runner";
const inject = ["agentDefaultModel", "agents", "sessions", "sessionPersistence"];
const Config = z.object({
	sessionId: z.string().required(),
	prompt: z.string().default("继续完成之前中断的任务。")
});
/** The process streams the runner writes to; tests substitute captures. */
const internals = {
	stdout: process.stdout,
	stderr: process.stderr
};
/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events, firstSeq) {
	let started = false;
	let text = "";
	let reason;
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			if (joined !== "") text = joined;
		}
		if (event.type === "turn/end") reason = event.data.reason;
	}
	return { text, reason };
}
/** Report an unexpected driver failure and request a failing exit. */
function fail(io, error) {
	io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
	io.exit(1);
}
/**
 * Resume one persisted session and deliver a continuation prompt.
 * @param ctx - plugin context carrying Agent, default model, Session, and launcher IO services.
 * @param config - validated resume options.
 * @param io - process-facing effects.
 */
async function run(ctx, config, io) {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	const sessions = ctx.get("sessions");
	if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return;
	const selection = defaultModel.currentSelection();
	const { agent } = await agents.resume({
		resumeSessionId: SessionId(config.sessionId),
		agentOptions: {
			provider: selection.provider,
			model: selection.model
		},
		setup: (agentCtx) => {
			installModelSelection(agentCtx, {
				current: selection,
				assembled: void 0
			});
		}
	});
	await agent.whenIdle();
	const firstSeq = agent.session.seq;
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text: config.prompt
		}],
		source: { kind: "user" }
	}));
	await agent.whenIdle();
	await sessions.flush(agent.session);
	const outcome = summarize(agent.session.events, firstSeq);
	io.stdout.write(outcome.text + "\n");
	if (outcome.reason?.kind === "error") io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
	io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}
/**
 * Mount the one-shot resume driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated resume config.
 */
function apply(ctx, config) {
	const exit = ctx.get("appExit");
	if (exit === void 0) throw new Error("resume-runner: the launcher must provide ctx.appExit before the tree mounts");
	const io = {
		stdout: internals.stdout,
		stderr: internals.stderr,
		exit
	};
	run(ctx, config, io).catch((error) => {
		fail(io, error);
	});
}
export { Config, apply, inject, internals, name };
