import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ProviderId = "nvidia" | "mistral";

export const PROVIDERS: ProviderId[] = ["nvidia", "mistral"];

export function envVarFor(provider: ProviderId): string {
  return provider === "nvidia" ? "NVIDIA_API_KEY" : "MISTRAL_API_KEY";
}

export function keyUrlFor(provider: ProviderId): string {
  return provider === "nvidia"
    ? "https://build.nvidia.com/settings/api-keys"
    : "https://console.mistral.ai";
}

export function parseProviderId(value: string | undefined): ProviderId | null {
  if (value === "nvidia" || value === "mistral") {
    return value;
  }
  return null;
}

export const CONFIG_DIR_ENV = "CODEWHIP_CONFIG_DIR";

type StoredCreds = {
  nvidiaApiKey?: unknown;
  mistralApiKey?: unknown;
};

function fieldFor(provider: ProviderId): "nvidiaApiKey" | "mistralApiKey" {
  return provider === "nvidia" ? "nvidiaApiKey" : "mistralApiKey";
}

export function configDir(): string {
  const override = process.env[CONFIG_DIR_ENV];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData !== undefined && appData.length > 0) {
      return path.join(appData, "codewhip");
    }
  }
  return path.join(os.homedir(), ".config", "codewhip");
}

function credsPath(): string {
  return path.join(configDir(), "credentials.json");
}

function readStored(): StoredCreds {
  try {
    const raw = fs.readFileSync(credsPath(), "utf8");
    return JSON.parse(raw) as StoredCreds;
  } catch {
    return {};
  }
}

export type KeySource = "env" | "file" | "none";

export function resolveKey(provider: ProviderId): { key: string; source: KeySource } {
  const fromEnv = process.env[envVarFor(provider)] ?? "";
  if (fromEnv.length > 0) {
    return { key: fromEnv, source: "env" };
  }
  const stored = readStored()[fieldFor(provider)];
  if (typeof stored === "string" && stored.length > 0) {
    return { key: stored, source: "file" };
  }
  return { key: "", source: "none" };
}

/** Back-compat default (nvidia). */
export function resolveApiKey(): { key: string; source: KeySource } {
  return resolveKey("nvidia");
}

function writeStored(next: Record<string, string>): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credsPath(), JSON.stringify(next) + "\n", { mode: 0o600 });
}

function preservedOther(provider: ProviderId): Record<string, string> {
  const other = fieldFor(provider === "nvidia" ? "mistral" : "nvidia");
  const kept = readStored()[other];
  if (typeof kept === "string" && kept.length > 0) {
    return { [other]: kept };
  }
  return {};
}

export function saveKey(provider: ProviderId, key: string): void {
  writeStored({ ...preservedOther(provider), [fieldFor(provider)]: key });
}

/** Back-compat default (nvidia). */
export function saveApiKey(key: string): void {
  saveKey("nvidia", key);
}

/** Returns false when nothing was stored. Preserves the other provider. */
export function clearKey(provider: ProviderId): boolean {
  const stored = readStored()[fieldFor(provider)];
  if (typeof stored !== "string" || stored.length === 0) {
    return false;
  }
  writeStored(preservedOther(provider));
  return true;
}

/** Back-compat default (nvidia). */
export function clearApiKey(): boolean {
  return clearKey("nvidia");
}

/** Hidden TTY prompt (prints *). Falls back to plain read when not a TTY. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      let data = "";
      stdin.resume();
      stdin.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      stdin.on("end", () => resolve(data.trim()));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const done = (value: string): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          done(buf);
          return;
        }
        if (ch === "\u0003") {
          done("");
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          stdout.write("\b \b");
        } else if (ch >= " " && buf.length < 500) {
          buf += ch;
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}
