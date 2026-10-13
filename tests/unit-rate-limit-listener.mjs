/**
 * onRateLimit hands a host every rate_limit_event verbatim, the bridge's named
 * rate-limit failure, and one accountInfo per subprocess. Payload shape below is a
 * real five_hour event recorded from Claude Code 2.1.280 (unifiedWindows included).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";
import { reportAccountInfo } from "../src/rate-limit-listeners.js";

const { __test, onRateLimit } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = { push() {}, end() {} };
	c.resetTurnState(fakeModel);
	c.piSessionId = "pi-session-1";
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), new Map(), fakeModel, () => false, c);
}

const allowed = {
	type: "rate_limit_event",
	session_id: "cc-session-1",
	rate_limit_info: {
		status: "allowed", resetsAt: 1791941400, rateLimitType: "five_hour",
		overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false,
		unifiedWindows: { five_hour: { utilization: 0.03, resetsAt: 1791941400 }, seven_day: { utilization: 0.34, resetsAt: 1792263600 } },
	},
};

describe("onRateLimit", () => {
	it("passes every rate_limit_event through verbatim with both session ids", async () => {
		const seen = [];
		const off = onRateLimit((o) => seen.push(o));
		try {
			await consume(makeCtx(), [allowed, allowed]);
		} finally { off(); }
		assert.equal(seen.length, 2);
		assert.equal(seen[0].kind, "rate_limit");
		assert.deepEqual(seen[0].info, allowed.rate_limit_info);
		assert.equal(seen[0].sessionId, "pi-session-1");
		assert.equal(seen[0].claudeSessionId, "cc-session-1");
		assert.equal(typeof seen[0].at, "number");
	});

	it("reports the named failure after a rejection", async () => {
		const seen = [];
		const off = onRateLimit((o) => seen.push(o));
		const rejection = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" } };
		const result = { type: "result", subtype: "success", is_error: true, result: "You're out of extra usage" };
		try {
			await consume(makeCtx(), [rejection, result]);
		} finally { off(); }
		const failure = seen.find((o) => o.kind === "rate_limit_failure");
		assert.ok(failure);
		assert.equal(failure.info.rateLimitType, "five_hour");
		assert.match(failure.error, /rate limit/i);
	});

	it("never lets a throwing listener break the turn", async () => {
		const off = onRateLimit(() => { throw new Error("listener bug"); });
		try {
			await consume(makeCtx(), [allowed]);
		} finally { off(); }
	});

	it("stops after unsubscribe", async () => {
		const seen = [];
		onRateLimit((o) => seen.push(o))();
		await consume(makeCtx(), [allowed]);
		assert.equal(seen.length, 0);
	});

	it("reports accountInfo once per query, only with a listener", async () => {
		let calls = 0;
		const fakeQuery = { accountInfo: async () => { calls++; return { email: "a@example.com", subscriptionType: "Claude Max" }; } };
		reportAccountInfo(fakeQuery, "s");
		assert.equal(calls, 0);
		const seen = [];
		const off = onRateLimit((o) => seen.push(o));
		try {
			reportAccountInfo(fakeQuery, "s");
			await new Promise((r) => setImmediate(r));
		} finally { off(); }
		assert.equal(calls, 1);
		assert.deepEqual(seen.map((o) => o.kind), ["account"]);
		assert.equal(seen[0].account.subscriptionType, "Claude Max");
		reportAccountInfo({}, "s");
	});
});
