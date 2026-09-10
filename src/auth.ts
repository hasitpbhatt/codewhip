import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ENV_VAR = "NVIDIA_API_KEY";
export const CONFIG_DIR_ENV = "CODEWHIP_CONFIG_DIR";

type StoredCreds = {
  nvidiaApiKey?: unknown;
};

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

export function resolveApiKey(): { key: string; source: KeySource } {
  const fromEnv = process.env[ENV_VAR] ?? "";
  if (fromEnv.length > 0) {
    return { key: fromEnv, source: "env" };
  }
  const stored = readStored().nvidiaApiKey;
  if (typeof stored === "string" && stored.length > 0) {
    return { key: stored, source: "file" };
  }
  return { key: "", source: "none" };
}

export function saveApiKey(key: string): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credsPath(), JSON.stringify({ nvidiaApiKey: key }) + "\n", {
    mode: 0o600,
  });
}

export function clearApiKey(): boolean {
  const stored = readStored();
  if (typeof stored.nvidiaApiKey !== "string" || stored.nvidiaApiKey.length === 0) {
    return false;
  }
  fs.writeFileSync(credsPath(), "{}\n", { mode: 0o600 });
  return true;
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
