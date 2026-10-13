/**
 * Host hook for Claude Code's plan rate-limit information.
 *
 * Claude Code sends a `rate_limit_event` with every request, and it is the only
 * place a host learns how much of the subscription window is left without making
 * calls of its own. The bridge already reads these for its toasts; this lets a host
 * (EECOM's propellant gauge) see them too, together with the account each
 * subprocess runs as, so readings can be keyed by account.
 *
 * Listeners are observers: a throwing listener is logged and never reaches the turn.
 */
import type { AccountInfo, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

export type RateLimitObservation =
	/** One `rate_limit_event`, verbatim (including undocumented fields such as unifiedWindows). */
	| { kind: "rate_limit"; info: SDKRateLimitInfo; sessionId: string | null; claudeSessionId: string | null; at: number }
	/** `accountInfo()` of a Claude Code subprocess, once per subprocess. */
	| { kind: "account"; account: AccountInfo; sessionId: string | null; at: number }
	/** A turn failed and the bridge named it a rate limit, from the rejection held just before it. */
	| { kind: "rate_limit_failure"; info: { rateLimitType?: string; resetsAt?: number }; error: string; sessionId: string | null; at: number };

export type RateLimitListener = (observation: RateLimitObservation) => void;

const listeners = new Set<RateLimitListener>();

/** Register a listener; returns its unsubscribe. */
export function onRateLimit(listener: RateLimitListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function hasRateLimitListeners(): boolean {
	return listeners.size > 0;
}

export function emitRateLimit(observation: RateLimitObservation, log: (...args: unknown[]) => void = () => {}): void {
	for (const listener of listeners) {
		try {
			listener(observation);
		} catch (error) {
			log("rate-limit listener threw", error);
		}
	}
}

/** Ask a fresh subprocess which account it runs as, once, without holding up the turn. */
export function reportAccountInfo(
	sdkQuery: { accountInfo?: () => Promise<AccountInfo> },
	sessionId: string | null,
	log: (...args: unknown[]) => void = () => {},
): void {
	if (!hasRateLimitListeners() || typeof sdkQuery.accountInfo !== "function") return;
	sdkQuery.accountInfo().then(
		(account) => emitRateLimit({ kind: "account", account, sessionId, at: Date.now() }, log),
		(error) => log("accountInfo failed", error),
	);
}
