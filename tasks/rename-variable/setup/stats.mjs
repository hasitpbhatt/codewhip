export function summarize(d) {
  const names = d.map((row) => row.name);
  const total = d.reduce((acc, row) => acc + row.value, 0);
  return { names, total, count: d.length };
}
