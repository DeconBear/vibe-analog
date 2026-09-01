/**
 * Per-round assistant text accumulation for desktop agent runs.
 *
 * The actoviq SDK's `response.text.delta` snapshot is scoped to a single
 * model iteration, so a naive accumulator keeps only the last round. This
 * tracker finalizes a round at each `request.started` boundary and prefers the
 * authoritative per-iteration summaries from the run result at finalize time.
 */

export interface DesktopAgentRound {
  iteration: number;
  text: string;
}

export interface AssistantRoundTracker {
  /** Accumulate one streamed delta; returns the current round's full text. */
  handleTextDelta(iteration: number, snapshot: string, delta: string): string;
  /** A new LLM request begins: flush the previous round's text (once). */
  flushRequestBoundary(): DesktopAgentRound | null;
  /**
   * Merge everything seen into the final round list. Per-iteration request
   * summaries (from response.completed / stream.result) are authoritative;
   * otherwise fall back to rounds flushed while streaming plus the tail text.
   */
  finalize(
    requests: Array<{ iteration: number; text?: string | null }> | undefined,
    finalText: string,
  ): DesktopAgentRound[];
}

export function createAssistantRoundTracker(): AssistantRoundTracker {
  let raw = '';
  let lastTextIteration: number | null = null;
  const rounds: DesktopAgentRound[] = [];
  const flushed = new Set<number>();
  return {
    handleTextDelta(iteration, snapshot, delta) {
      lastTextIteration = iteration;
      raw = snapshot || raw + delta;
      return raw;
    },
    flushRequestBoundary() {
      const text = raw.trim();
      raw = '';
      if (!text || lastTextIteration === null || flushed.has(lastTextIteration)) return null;
      flushed.add(lastTextIteration);
      const round: DesktopAgentRound = { iteration: lastTextIteration, text };
      rounds.push(round);
      return round;
    },
    finalize(requests, finalText) {
      const summary = (requests ?? [])
        .map((entry) => ({ iteration: entry.iteration, text: (entry.text ?? '').trim() }))
        .filter((entry) => entry.text.length > 0);
      if (summary.length > 0) return summary;
      const streamed = [...rounds];
      const tail = finalText.trim();
      if (tail && (lastTextIteration === null || !flushed.has(lastTextIteration))) {
        streamed.push({ iteration: lastTextIteration ?? streamed.length + 1, text: tail });
      }
      return streamed;
    },
  };
}
