import { sha256Hex } from "./hash.js";

export type BudgetState = {
  total: number;
  allocated: number;
  remaining: number;
};

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

  const budgetForChildren = Math.max(1, Math.floor(parentRemaining * childShare));
  const coordBudget = Math.max(0, parentRemaining - budgetForChildren);

  const perChild = Math.max(1, Math.floor(budgetForChildren / childrenCount));
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

export function createBudgetState(total: number): BudgetState {
  return { total, allocated: 0, remaining: total };
}

export function consumeBudget(state: BudgetState, used: number): void {
  state.allocated += used;
  state.remaining = Math.max(0, state.total - state.allocated);
}

export function canBorrowFromPool(
  poolRemaining: number,
  childAllocation: number,
  childUsed: number
): number {
  const childRemaining = childAllocation - childUsed;
  const borrowable = Math.max(0, poolRemaining - childRemaining);
  return borrowable;
}

export function recalculateAllocation(
  parentRemaining: number,
  originalChildren: ChildAllocation[],
  childrenCount: number,
  options: { childShare?: number; coordinationReserve?: number } = {}
): BudgetAllocationResult {
  const allocation = allocateChildBudgets(parentRemaining, childrenCount, options);
  allocation.children.forEach((child, i) => {
    if (i < originalChildren.length) {
      const orig = originalChildren[i]!;
      child.used = orig.used;
      if (child.allocated < orig.used) {
        child.allocated = orig.used;
      }
    }
  });
  return allocation;
}

export function formatBudgetDebug(budget: BudgetAllocationResult): string {
  const total = budget.parentBudget;
  const coord = budget.coordinationBudget;
  const childTotal = budget.children.reduce((s, c) => s + c.allocated, 0);
  return `budget: parent=${total} coord=${coord} children=${childTotal} (${budget.children.length} children)`;
}
