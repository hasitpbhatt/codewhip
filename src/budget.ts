import { sha256Hex } from "./hash.js";

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
