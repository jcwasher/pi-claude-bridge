/** The pi stream can end on abort before the SDK iterator has unwound. Hosts
 * must be able to await that cleanup for one session without waiting on others. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-consumer-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));
const mod = await import("../src/index.js");
let provider;
mod.default({ on: () => {}, registerProvider: (_name, config) => { provider = config; }, registerTool: () => {} });
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

it("waitForSession waits for aborted SDK cleanup, isolates sessions, and settles after query errors", async () => {
	assert.equal(typeof mod.waitForSession, "function", "hosts need the exported cleanup barrier");
	const scripts = [];
	const controllers = [];
	mod.__test.setQuery(() => {
		const script = scripts.shift();
		const gen = (async function* () {
			try {
				yield { type: "system", subtype: "init", session_id: script.id };
				const events = [
					{ type: "message_start", message: { id: `msg-${script.id}`, usage: {} } },
					{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tool-${script.id}`, name: "mcp__custom-tools__read", input: {} } },
					{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
					{ type: "message_stop" },
				];
				if (!script.error) for (const event of events) yield { type: "stream_event", event };
				script.started.resolve();
				await script.release.promise;
				if (script.error) throw new Error("fake SDK failure");
			} finally { script.unwound = true; }
		})();
		gen.interrupt = async () => {};
		// Killing the subprocess does not synchronously finish the iterator.
		gen.close = () => { script.closed = true; };
		return gen;
	});
	const start = async (sessionId, error = false) => {
		const script = { id: `cc-${sessionId}`, started: deferred(), release: deferred(), error, closed: false, unwound: false };
		scripts.push(script);
		const controller = new AbortController();
		controllers.push(controller);
		const stream = provider.streamSimple(provider.models[0], {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
		}, { sessionId, signal: controller.signal });
		await script.started.promise;
		return { script, controller, stream };
	};
	let a, replacement, b, failing;
	try {
		a = await start("pi-a");
		replacement = await start("pi-a");
		b = await start("pi-b");
		a.controller.abort();
		replacement.controller.abort();
		await a.stream.result();
		assert.equal(a.script.closed, true);
		assert.equal(a.script.unwound, false, "pi completion precedes SDK cleanup");
		let drained = false;
		const drain = mod.waitForSession("pi-a").then(() => { drained = true; });
		await tick();
		assert.equal(drained, false, "the barrier must not return while the old SDK iterator is live");
		await mod.waitForSession("unknown-session");
		a.script.release.resolve();
		await tick();
		assert.equal(drained, false, "all consumers of the session must finish, not only the first");
		replacement.script.release.resolve();
		await drain;
		assert.equal(a.script.unwound, true);
		assert.equal(b.script.unwound, false, "other sessions must not block this barrier");
		await mod.waitForSession("pi-a");

		failing = await start("pi-error", true);
		failing.script.release.resolve();
		await mod.waitForSession("pi-error");
		assert.equal((await failing.stream.result()).stopReason, "error");
		assert.equal(failing.script.closed, true, "the error path also completes cleanup");
	} finally {
		for (const controller of controllers) controller.abort();
		for (const run of [a, replacement, b, failing]) run?.script.release.resolve();
		await Promise.all(["pi-a", "pi-b", "pi-error"].map((id) => mod.waitForSession(id)));
		mod.__test.setQuery(null);
	}
});
