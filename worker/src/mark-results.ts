/**
 * Cross-store merge for the batched mark_processed form (#245).
 *
 * Kept out of agent.ts so it can be unit-tested without the McpAgent /
 * Durable Object runtime: the merge is where a batch's per-id verdict is
 * actually decided, and that decision is easy to get subtly wrong under
 * multi-account fan-out.
 *
 * Fan-out shape: a session may read several tenant stores (user + orgs). The
 * same batch is POSTed to every accessible store, but each event lives in
 * exactly ONE of them — so "not found" from the other stores is the normal
 * case, not a failure. An id is marked when ANY store matched it; only an id
 * that every store missed has actually failed.
 */

/** Per-id verdict surfaced to the caller. */
export type MarkResult = { event_id: string; success: boolean; error?: string };

/** Batch response shape from one WebhookStore DO's /mark-processed route. */
export type StoreBatchResponse = {
  success: boolean;
  results?: { event_id: unknown; success: boolean; error?: string }[];
  purged?: number;
};

/** Aggregate returned by the batched mark_processed tool. */
export type MarkBatchSummary = {
  success: boolean;
  marked: number;
  failed: number;
  results: MarkResult[];
  purged: number;
};

/**
 * Merge per-store batch responses into one per-id verdict list.
 *
 * `results` follows the order of `event_ids` (the order the caller asked in),
 * so a caller can line the verdicts up against its own list. `success` is the
 * all-ids-marked verdict; partial failure is reported here rather than as a
 * tool error, because the ids that succeeded are already committed and the
 * caller needs to see exactly which ids to retry.
 */
export function mergeMarkResults(
  event_ids: string[],
  perStore: StoreBatchResponse[],
): MarkBatchSummary {
  const verdicts = new Map<string, MarkResult>(
    event_ids.map((id) => [id, { event_id: id, success: false, error: "not found" }]),
  );

  let purged = 0;
  for (const store of perStore) {
    purged += store.purged ?? 0;
    for (const r of store.results ?? []) {
      // Only successes are promoted: a miss from one store says nothing about
      // the others, and the map already holds "not found" as the default.
      // Store-side `error` strings are deliberately NOT propagated — a
      // per-store reason describes one store, not the merged verdict. This is
      // why "not found" is the only error the tool surface emits, and why the
      // tool schema rejects empty ids rather than letting them arrive here as
      // a store-level "invalid event_id" that this merge would flatten.
      if (r.success && typeof r.event_id === "string" && verdicts.has(r.event_id)) {
        verdicts.set(r.event_id, { event_id: r.event_id, success: true });
      }
    }
  }

  const results = [...verdicts.values()];
  const failed = results.filter((r) => !r.success).length;

  return {
    success: failed === 0,
    marked: results.length - failed,
    failed,
    results,
    purged,
  };
}
