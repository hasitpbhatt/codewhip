/** Maximum built-in tools allowed to execute concurrently in one turn. */
export const MAX_PARALLEL_TOOL_CALLS = 4;

/**
 * Run independent work concurrently while preserving input order in `results`.
 * A rejection rejects the returned promise; callers own the never-throw tool
 * boundary and convert failures into ToolResult strings.
 */
export async function runBoundedParallel<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
