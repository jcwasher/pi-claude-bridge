/**
 * Host hook for Claude Code's `<synthetic>` reports that turned out not to end the turn.
 *
 * Claude Code reports some API failures as a synthetic assistant message and then carries
 * on: a request rejected for an image ("API Error: an image in the conversation could not
 * be processed and was removed. …") is retried without the image, and the real answer
 * follows. The bridge takes such a report out of the turn's content, so it never reads as
 * the reply; this lets a host (EECOM's station) surface it as a notice instead.
 *
 * Listeners are observers: a throwing listener is logged and never reaches the turn.
 */
export interface ClaudeCodeReport {
	/** The report's text, verbatim. */
	text: string;
	sessionId: string | null;
	at: number;
}

export type ReportListener = (report: ClaudeCodeReport) => void;

const listeners = new Set<ReportListener>();

/** Register a listener; returns its unsubscribe. */
export function onReport(listener: ReportListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function emitReport(report: ClaudeCodeReport, log: (...args: unknown[]) => void = () => {}): void {
	for (const listener of listeners) {
		try {
			listener(report);
		} catch (error) {
			log("report listener threw", error);
		}
	}
}
