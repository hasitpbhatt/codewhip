import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config-dir.js";

type BlockEntry = {
  provider: string;
  model: string;
  /** ISO ts when the model was permanently blocked (410 received). */
  blockedAt: string;
};

const FILE = "provider-blocklist.json";

function filePath(): string {
  return path.join(configDir(), FILE);
}

function loadEntries(): BlockEntry[] {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const parsed = JSON.parse(raw) as BlockEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is BlockEntry =>
        typeof e.provider === "string" && typeof e.model === "string",
    );
  } catch {
    return [];
  }
}

function saveEntries(entries: BlockEntry[]): void {
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath(), JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // best-effort
  }
}

/** Add a (provider, model) to the permanent blocklist. No-op if already blocked. */
export function blockModel(provider: string, model: string): void {
  const entries = loadEntries();
  if (entries.some((e) => e.provider === provider && e.model === model)) return;
  entries.push({ provider, model, blockedAt: new Date().toISOString() });
  saveEntries(entries);
}

/** Returns true if the model is permanently blocked for this provider (410 received). */
export function isBlocked(provider: string, model: string): boolean {
  const entries = loadEntries();
  return entries.some((e) => e.provider === provider && e.model === model);
}

/** Return all permanently blocked entries. */
export function listBlocked(): BlockEntry[] {
  return loadEntries();
}

/** Remove a model from the permanent blocklist. Returns true if it was removed. */
export function unblockModel(provider: string, model: string): boolean {
  const entries = loadEntries();
  const idx = entries.findIndex((e) => e.provider === provider && e.model === model);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  saveEntries(entries);
  return true;
}
