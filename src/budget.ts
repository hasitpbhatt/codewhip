import { sha256Hex } from "./hash.js";

/**
 * A ledger masquerading as an allocation — narrowed to its two real lines.
 *
 * This module answers exactly one question: given what the parent has left,
 * how much does each child get, and how much stays with the parent? The
 * `used`/`status` fields are carried by no caller and the hashed child ids are
 * a constant string over the index, so they exist to be read, not to be
 * written; the invariant that matters is `Σ allocated ≤ parentRemaining`, which
 * is pinned by `src/budget.test.ts` over a table of (parent, count) pairs
 * rather than by the examples in it.
 *
 * Surfaces must read `allocated === 0` as "not enough pool for this child" and
 * say so: the child runner deliberately will not re-floor a 0 into 1 (see
 * `runChildAgent`), because a floor is how the split stops being a split.
 */

export type ChildAllocation = {
  id: string;
  allocated: number;
  used: number;
  status: "pending" | "running" | "done" | "error";
};

export type BudgetAllocationResult = {
  parentBudget: number;
  coordinationBudget: number;
  children: ChildAllocation[];
};

const DEFAULT_CHILD_SHARE = 0.85;

function generateChildId(name: string, index: number): string {
  return `${name}-${index}-${sha256Hex(name + index).slice(0, 8)}`;
}

export function allocateChildBudgets(
  parentRemaining: number,
  childrenCount: number,
  options: {
    childShare?: number;
  } = {}
): BudgetAllocationResult {
  const childShare = options.childShare ?? DEFAULT_CHILD_SHARE;

  // No `Math.max(1, …)` clamp anywhere. A clamp makes each child look owed at
  // least one token, so four children on a 2-token remainder each get 1 and
  // the SUM exceeds the pool it was split from — the over-allocation that
  // made "children are capped by the parent's budget" false exactly when the
  // budget was tight enough to matter. The remainder belongs to the
  // coordination reserve and is reported as unallocated, not distributed.
  const pool = Math.max(0, Math.floor(parentRemaining));
  const budgetForChildren = Math.floor(pool * childShare);
  const coordBudget = pool - budgetForChildren;

  const perChild = childrenCount <= 0 ? 0 : Math.floor(budgetForChildren / childrenCount);
  const children: ChildAllocation[] = [];

  for (let i = 0; i < childrenCount; i++) {
    children.push({
      id: generateChildId(`child-${i}`, i),
      allocated: perChild,
      used: 0,
      status: "pending",
    });
  }

  return {
    parentBudget: parentRemaining,
    coordinationBudget: coordBudget,
    children,
  };
}
