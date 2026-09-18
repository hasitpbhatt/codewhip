export function lastN(arr, n) {
  return arr.slice(arr.length - n - 1); // BUG: one too many
}
