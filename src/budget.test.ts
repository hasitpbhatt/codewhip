import test from "node:test";
import assert from "node:assert/strict";
import { allocateChildBudgets } from "./budget.js";

/**
 * The child budget split (`src/budget.ts`).
 *
 * This module had no test file at all while the arithmetic it owned was
 * wrong: `Math.max(1, …)` clamps made each child look owed at least one token,
 * so four children on a two-token remainder each drew 1 and the SUM exceeded
 * the pool it was split from — while `parentBudget` still reported 2. The
 * invariant that matters is the sum, so it is pinned over a table rather than
 * by the examples that follow.
 */

test("the sum of allocations never exceeds the parent's remaining budget", () => {
  for (const parent of [0, 1, 2, 3, 4, 5, 9, 10, 99, 100, 250_000]) {
    for (const count of [1, 2, 3, 4]) {
      const r = allocateChildBudgets(parent, count);
      const sum = r.children.reduce((s, c) => s + c.allocated, 0);
      assert.ok(
        sum + r.coordinationBudget <= parent,
        `parent=${parent} count=${count}: children ${sum} + coord ${r.coordinationBudget} > ${parent}`
      );
      assert.equal(r.parentBudget, parent, "the reported pool is the real pool, not a rounded one");
      assert.equal(r.children.length, count, "every child is still reported, funded or not");
    }
  }
});

test("a tight pool zeroes the children it cannot fund instead of flooring them", () => {
  const r = allocateChildBudgets(2, 4);
  assert.deepEqual(r.children.map((c) => c.allocated), [0, 0, 0, 0]);
  assert.equal(r.coordinationBudget, 1, "the remainder stays with the coordination reserve");
  // The old clamp produced [1,1,1,1] here — 4 tokens out of a 2-token pool.
  assert.equal(r.children.reduce((s, c) => s + c.allocated, 0), 0);
});

test("the default 85% child share / 15% coordination reserve", () => {
  const r = allocateChildBudgets(100, 1);
  assert.equal(r.children[0]?.allocated, 85);
  assert.equal(r.coordinationBudget, 15);
  const two = allocateChildBudgets(100, 2);
  assert.equal(two.children[0]?.allocated, 42);
  assert.equal(two.children[1]?.allocated, 42);
  assert.equal(two.coordinationBudget, 15, "the reserve is held once, not per child");
});

test("a negative or zero pool allocates nothing and reports no NaN", () => {
  for (const parent of [0, -5, -1000]) {
    const r = allocateChildBudgets(parent, 4);
    assert.equal(r.children.reduce((s, c) => s + c.allocated, 0), 0);
    assert.equal(r.coordinationBudget, 0);
    for (const c of r.children) assert.equal(Number.isFinite(c.allocated), true);
  }
});

test("childrenCount 0 allocates an empty list, not an infinity", () => {
  const r = allocateChildBudgets(1000, 0);
  assert.deepEqual(r.children, []);
  assert.equal(r.coordinationBudget, 150, "the reserve is the pool's own remainder");
});

test("an explicit childShare overrides the default and still honours the sum", () => {
  const r = allocateChildBudgets(100, 2, { childShare: 0.5 });
  assert.equal(r.children[0]?.allocated, 25);
  assert.equal(r.coordinationBudget, 50);
  assert.ok(r.children.reduce((s, c) => s + c.allocated, 0) + r.coordinationBudget <= 100);
});
