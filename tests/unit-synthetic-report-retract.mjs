/**
 * Claude Code reports a request it could not send with an image as a <synthetic> assistant
 * message ("API Error: an image in the conversation could not be processed and was
 * removed. …"), drops the image and asks again, and the real answer follows in the same
 * turn. The report used to stay at the head of the turn's content, so the host showed it as
 * the start of the reply. Once Claude Code carries on, it leaves the content and goes to
 * onReport listeners instead; a turn that fails keeps it (tests/unit-error-result.mjs).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test, onReport } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);
const REPORT = "API Error: an image in the conversation could not be processed and was removed. Re-read the file with a different approach if you still need it.";

function makeCtx() {
	const c = new QueryContext();
	const events = [];
	c.currentPiStream = { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
	c.resetTurnState(fakeModel);
	c.piSessionId = "pi-session";
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);
}

const synthetic = { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: REPORT }] } };
const answer = (id, text) => [
	{ type: "stream_event", event: { type: "message_start", message: { id } } },
	{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
	{ type: "stream_event", event: { type: "message_stop" } },
	{ type: "assistant", message: { id, model: "claude", content: [{ type: "text", text }] } },
];
const success = { type: "result", subtype: "success", is_error: false, result: "OK, done." };

function listen() {
	const reports = [];
	const off = onReport((report) => reports.push(report));
	return { reports, off };
}

describe("a <synthetic> report Claude Code carries on past", () => {
	it("leaves the turn's content when the answer streams after it", async () => {
		const c = makeCtx();
		const { reports, off } = listen();
		try {
			await consume(c, [synthetic, ...answer("msg_real", "OK, done."), success]);
		} finally { off(); }

		assert.deepStrictEqual(c.turnOutput.content, [{ type: "text", text: "OK, done." }]);
		assert.strictEqual(c.turnOutput.stopReason, "stop");
		assert.deepStrictEqual(reports.map((r) => [r.text, r.sessionId]), [[REPORT, "pi-session"]]);
		// Every streamed block's contentIndex is still its index in the final content.
		for (const e of c.currentPiStream.events.filter((e) => e.type === "text_end")) {
			assert.strictEqual(c.turnOutput.content[e.contentIndex].text, e.content);
		}
	});

	it("leaves it when the answer arrives as a non-streaming assistant message", async () => {
		const c = makeCtx();
		const { reports, off } = listen();
		try {
			await consume(c, [synthetic, { type: "assistant", message: { id: "msg_real", model: "claude", content: [{ type: "text", text: "OK, done." }] } }]);
		} finally { off(); }

		assert.deepStrictEqual(c.turnOutput.content, [{ type: "text", text: "OK, done." }]);
		assert.strictEqual(reports.length, 1);
	});

	it("keeps it on a turn that fails", async () => {
		const c = makeCtx();
		const { reports, off } = listen();
		const failure = { type: "result", subtype: "success", is_error: true, result: REPORT };
		try {
			await consume(c, [synthetic, failure]);
		} finally { off(); }

		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, REPORT);
		assert.deepStrictEqual(c.turnOutput.content, [{ type: "text", text: REPORT }]);
		assert.strictEqual(reports.length, 0);
	});

	it("a throwing listener never reaches the turn", async () => {
		const c = makeCtx();
		const off = onReport(() => { throw new Error("listener broke"); });
		try {
			await consume(c, [synthetic, ...answer("msg_real", "OK, done."), success]);
		} finally { off(); }

		assert.deepStrictEqual(c.turnOutput.content, [{ type: "text", text: "OK, done." }]);
	});
});
