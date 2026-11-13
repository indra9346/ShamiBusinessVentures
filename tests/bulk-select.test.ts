import { test } from "node:test";
import assert from "node:assert/strict";
import { keepSelectable, runOneByOne, selectionState, toggleAllSelected, toggleSelected } from "../src/lib/bulk-select.ts";

test("ticking one, then all shown, then clearing", () => {
  let selected: ReadonlySet<string> = new Set();
  selected = toggleSelected(selected, "a", true);
  assert.equal(selectionState(selected, ["a", "b", "c"]), "some");
  selected = toggleAllSelected(selected, ["a", "b", "c"], true);
  assert.equal(selectionState(selected, ["a", "b", "c"]), "all");
  selected = toggleSelected(selected, "b", false);
  assert.deepEqual([...selected].sort(), ["a", "c"]);
  selected = toggleAllSelected(selected, ["a", "b", "c"], false);
  assert.equal(selectionState(selected, ["a", "b", "c"]), "none");
  assert.equal(selectionState(new Set(), []), "none", "an empty list is never 'all'");
});

test("select all only touches the rows shown", () => {
  const selected = toggleAllSelected(new Set(["hidden"]), ["a", "b"], true);
  assert.deepEqual([...selected].sort(), ["a", "b", "hidden"]);
  assert.deepEqual([...toggleAllSelected(selected, ["a", "b"], false)], ["hidden"]);
});

test("a row that leaves the list or can no longer be deleted loses its tick", () => {
  const selected = new Set(["a", "b", "gone"]);
  assert.deepEqual([...keepSelectable(selected, ["a", "b", "c"])].sort(), ["a", "b"]);
  const same = new Set(["a"]);
  assert.equal(keepSelectable(same, ["a", "b"]), same, "unchanged selection keeps its identity (no re-render loop)");
});

test("rows are deleted one after another; a refused one is reported and the rest go ahead", async () => {
  const calls: string[] = [];
  let running = 0;
  const progress: number[] = [];
  const result = await runOneByOne(["a", "b", "c"], async (id) => {
    running += 1;
    assert.equal(running, 1, "never two at once");
    calls.push(id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running -= 1;
    if (id === "b") throw new Error("Money came for this checkout and was refunded, so it stays for the accounts.");
  }, (finished) => progress.push(finished));
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.deepEqual(result.done, ["a", "c"]);
  assert.deepEqual(result.failed, [{ item: "b", message: "Money came for this checkout and was refunded, so it stays for the accounts." }]);
  assert.deepEqual(progress, [1, 2, 3]);
  const blank = await runOneByOne(["x"], async () => { throw new Error(""); });
  assert.equal(blank.failed[0]!.message, "Could not delete it");
});
