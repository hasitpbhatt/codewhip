import * as os from "node:os";
import * as path from "node:path";

export const CONFIG_DIR_ENV = "CODEWHIP_CONFIG_DIR";

/**
 * Global config dir: %APPDATA%\\codewhip (win32) or ~/.config/codewhip
 * (posix). Overridable via CODEWHIP_CONFIG_DIR (tests, CI).
 */
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
