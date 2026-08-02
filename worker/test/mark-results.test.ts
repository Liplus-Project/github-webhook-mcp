/**
 * Unit tests for worker/src/mark-results.ts :: mergeMarkResults (#245).
 *
 * This is the cross-store merge behind the batched mark_processed form. The
 * batch is POSTed to every store the session can read, but each event lives in
 * exactly one of them — so the merge has to read "not found" from the other
 * stores as normal, not as failure. Getting that backwards would report every
 * id as failed on any multi-account session, so it is pinned directly here
 * rather than only through the DO integration tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMarkResults, type StoreBatchResponse } from "../src/mark-results.js";

/** One store's batch response, with the shape the DO route returns. */
function store(
  results: { event_id: unknown; success: boolean; error?: string }[],
  purged = 0,
): StoreBatchResponse {
  return { success: true, results, purged };
}

test("single store: all ids matched", () => {
  const merged = mergeMarkResults(
    ["a", "b"],
    [store([{ event_id: "a", success: true }, { event_id: "b", success: true }], 2)],
  );
  assert.deepEqual(merged, {
    success: true,
    marked: 2,
    failed: 0,
    results: [
      { event_id: "a", success: true },
      { event_id: "b", success: true },
    ],
    purged: 2,
  });
});

test("multi-store fan-out: an id matched by ANY store counts as marked", () => {
  // "a" lives in store 1, "b" in store 2. Each store misses the other's id.
  const merged = mergeMarkResults(
    ["a", "b"],
    [
      store([
        { event_id: "a", success: true },
        { event_id: "b", success: false, error: "not found" },
      ]),
      store([
        { event_id: "a", success: false, error: "not found" },
        { event_id: "b", success: true },
      ]),
    ],
  );
  assert.equal(merged.success, true);
  assert.equal(merged.marked, 2);
  assert.equal(merged.failed, 0);
});

test("an id missed by EVERY store is the only real failure", () => {
  const merged = mergeMarkResults(
    ["a", "ghost"],
    [
      store([
        { event_id: "a", success: true },
        { event_id: "ghost", success: false, error: "not found" },
      ]),
      store([
        { event_id: "a", success: false, error: "not found" },
        { event_id: "ghost", success: false, error: "not found" },
      ]),
    ],
  );
  assert.equal(merged.success, false);
  assert.equal(merged.marked, 1);
  assert.equal(merged.failed, 1);
  assert.deepEqual(merged.results, [
    { event_id: "a", success: true },
    { event_id: "ghost", success: false, error: "not found" },
  ]);
});

test("results follow the caller's id order regardless of store response order", () => {
  const merged = mergeMarkResults(
    ["z", "y", "x"],
    [store([{ event_id: "x", success: true }, { event_id: "z", success: true }])],
  );
  assert.deepEqual(
    merged.results.map((r) => r.event_id),
    ["z", "y", "x"],
  );
});

test("purged counts sum across stores", () => {
  const merged = mergeMarkResults(
    ["a"],
    [store([{ event_id: "a", success: true }], 3), store([], 4)],
  );
  assert.equal(merged.purged, 7);
});

test("a store omitting results / purged does not break the merge", () => {
  // Defensive against an older DO revision answering the singular shape.
  const merged = mergeMarkResults(["a"], [{ success: true } as StoreBatchResponse]);
  assert.deepEqual(merged, {
    success: false,
    marked: 0,
    failed: 1,
    results: [{ event_id: "a", success: false, error: "not found" }],
    purged: 0,
  });
});

test("an id a store reports that the caller never asked for is ignored", () => {
  const merged = mergeMarkResults(
    ["a"],
    [store([{ event_id: "a", success: true }, { event_id: "stray", success: true }])],
  );
  assert.deepEqual(merged.results, [{ event_id: "a", success: true }]);
});

test("empty id list yields an empty, successful merge", () => {
  const merged = mergeMarkResults([], [store([])]);
  assert.deepEqual(merged, { success: true, marked: 0, failed: 0, results: [], purged: 0 });
});
