export function validate(input) {
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new Error("bad input");
  }
  return true;
}
