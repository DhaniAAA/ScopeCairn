import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/retrieval/classify.js";
import type { RankedSymbol } from "../src/retrieval/retrieve.js";

function sym(over: Partial<RankedSymbol>): RankedSymbol {
  return {
    id: 1,
    name: "foo",
    type: "function",
    file: "src/a.ts",
    score: 0.5,
    reason: "test",
    signature: "",
    parts: { seed: 0, proximity: 0, centrality: 0, recency: 0, cochange: 0 },
    ...over,
  } as RankedSymbol;
}

test("SIMPLE when one file, one module, low fanin", () => {
  const c = classify([sym({ id: 1 })], () => 0);
  assert.equal(c.complexity, "SIMPLE");
  assert.equal(c.estimatedFiles, 1);
});

test("COMPLEX when >=3 files", () => {
  const ranked = [
    sym({ id: 1, file: "src/a.ts" }),
    sym({ id: 2, file: "src/b.ts" }),
    sym({ id: 3, file: "src/c.ts" }),
  ];
  const c = classify(ranked, () => 0);
  assert.equal(c.complexity, "COMPLEX");
});

test("COMPLEX when crossing modules", () => {
  const ranked = [
    sym({ id: 1, file: "src/a.ts" }),
    sym({ id: 2, file: "lib/b.ts" }),
  ];
  const c = classify(ranked, () => 0);
  assert.equal(c.complexity, "COMPLEX");
});

test("COMPLEX when high fanin on definitional symbol", () => {
  const c = classify([sym({ id: 9, name: "hot" })], () => 10);
  assert.equal(c.complexity, "COMPLEX");
  assert.ok(c.highFanin.includes("hot"));
});

test("low-score symbols are ignored below threshold", () => {
  const c = classify([sym({ score: 0.01 })], () => 0);
  assert.equal(c.estimatedFiles, 0);
  assert.equal(c.complexity, "SIMPLE");
});
