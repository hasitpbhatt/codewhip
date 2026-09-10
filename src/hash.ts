import { createHash } from "node:crypto";

/** Stable JSON: object keys sorted recursively, so hashes reproduce. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable args hash for audit/outcomes (Week-3 verify depends on this). */
export function argsHash(args: unknown): string {
  return sha256Hex(canonicalJson(args));
}
