import * as fs from "node:fs";
import * as path from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson, sha256Hex } from "./hash.js";

/**
 * Append-only, hash-chained action log — `.codewhip/audit.log` (one JSON
 * object per line). Schema frozen for H1 (Ruling 2):
 *   {v, seq, ts, runId, actor, tool, args_hash, result_hash, prev_hash, policy, sig}
 * Chain: every entry commits to the full prior history, because each entry's
 * content hash includes `prev_hash`, and the next entry's `prev_hash` is that
 * hash. `prev_hash` is "" at genesis. Entries are ed25519-signed with the
 * keypair `init` generated (`sig: null` in unsigned repos — `--verify` then
 * checks the hash chain and reports the missing signatures).
 *
 * Redaction-at-write is satisfied by construction: only hashes, policy ids,
 * and timestamps are stored — never raw args or output. `args_hash`/
 * `result_hash` are computed at the call site from the same redacted-before-
 * forwarding text the provider saw (matches outcomes.jsonl byte-for-byte).
 */
export const AUDIT_SCHEMA_V = 1;

export type AuditActor = "policy" | "human" | "remembered" | "yolo";

export type AuditEntry = {
  v: 1;
  seq: number;
  ts: string;
  runId: string;
  actor: AuditActor;
  tool: string;
  args_hash: string;
  result_hash: string;
  prev_hash: string;
  policy: string;
  sig: string | null;
};

export type AuditInput = {
  runId: string;
  actor: AuditActor;
  tool: string;
  args_hash: string;
  result_hash: string;
  policy: string;
};

export function auditPath(cwd: string): string {
  return path.join(cwd, ".codewhip", "audit.log");
}

/** The content a signature commits to: the entry minus its own signature. */
export function entryContent(e: AuditEntry): AuditEntry {
  return { ...e, sig: null };
}

export function entryHash(e: AuditEntry): string {
  return sha256Hex(canonicalJson(entryContent(e)));
}

function loadPrivateKey(cwd: string): KeyObject | null {
  try {
    return createPrivateKey(fs.readFileSync(path.join(cwd, ".codewhip", "key"), "utf8"));
  } catch {
    return null;
  }
}

function loadPublicKey(cwd: string): KeyObject | null {
  try {
    return createPublicKey(fs.readFileSync(path.join(cwd, ".codewhip", "key.pub"), "utf8"));
  } catch {
    return null;
  }
}

export function readAuditLog(cwd: string): { entries: AuditEntry[]; parseErrors: string[] } {
  const entries: AuditEntry[] = [];
  const parseErrors: string[] = [];
  try {
    const raw = fs.readFileSync(auditPath(cwd), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i] as string) as AuditEntry);
      } catch {
        parseErrors.push(`line ${i + 1}: not valid JSON`);
      }
    }
  } catch {
    // Missing file = empty chain.
  }
  return { entries, parseErrors };
}

export function readLastAuditEntries(cwd: string, n: number): AuditEntry[] {
  const { entries } = readAuditLog(cwd);
  return entries.slice(-Math.max(1, n));
}

export function readLastAuditRaw(cwd: string, n: number): string {
  try {
    const lines = fs.readFileSync(auditPath(cwd), "utf8").split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-Math.max(1, n)).join("\n");
  } catch {
    return "";
  }
}

/**
 * Append one entry to the chain. Returns false (never throws) on disk
 * failure so the agent loop keeps running. Reads the tail to derive
 * `seq` and `prev_hash`, so sequences are global across runs.
 *
 * Hardened (P0): mkdir-lock against concurrent-run seq forks (best-effort,
 * bounded retries), plus fsync per append so a crash loses at most one
 * entry — never the whole buffered trail (loop flushes per call).
 */
export function appendEntry(cwd: string, input: AuditInput): boolean {
  const dir = path.join(cwd, ".codewhip");
  const lockDir = path.join(dir, "audit.lock");
  for (let i = 0; i < 50; i++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(lockDir);
      break;
    } catch {
      if (i === 49) return false;
      const wait = 10 + Math.floor(Math.random() * 20);
      const end = Date.now() + wait;
      while (Date.now() < end) { /* bounded spin, no deps */ }
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 5000) fs.rmdirSync(lockDir);
      } catch { /* lock vanished, retry */ }
    }
  }
  try {
    const { entries } = readAuditLog(cwd);
    const last = entries[entries.length - 1];
    const sigBase: AuditEntry = {
      v: 1,
      seq: last === undefined ? 1 : last.seq + 1,
      ts: new Date().toISOString(),
      runId: input.runId,
      actor: input.actor,
      tool: input.tool,
      args_hash: input.args_hash,
      result_hash: input.result_hash,
      prev_hash: last === undefined ? "" : entryHash(last),
      policy: input.policy,
      sig: null,
    };
    const priv = loadPrivateKey(cwd);
    const sig =
      priv === null
        ? null
        : edSign(null, Buffer.from(entryHash(sigBase), "utf8"), priv).toString("hex");
    const fd = fs.openSync(auditPath(cwd), "a");
    try {
      fs.writeFileSync(fd, JSON.stringify({ ...sigBase, sig }) + "\n", "utf8");
      try {
        fs.fsyncSync(fd);
      } catch { /* fsync best-effort (tmpfs/CI) */ }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch { /* lock release best-effort */ }
  }
}

/**
 * Sign an arbitrary canonical blob with the repo key. Null in unsigned repos.
 * Shared by --export and --share so both bundles carry the same trust root.
 */
export function signBlob(cwd: string, canonical: string): string | null {
  const priv = loadPrivateKey(cwd);
  if (priv === null) {
    return null;
  }
  return edSign(null, Buffer.from(canonical, "utf8"), priv).toString("hex");
}

/** Hash of the last chain entry ("" when empty) — anchors exports/shares. */
export function chainTail(cwd: string): string {
  const { entries } = readAuditLog(cwd);
  if (entries.length === 0) {
    return "";
  }
  return entryHash(entries[entries.length - 1] as AuditEntry);
}

export type AuditVerification = {
  valid: boolean;
  total: number;
  signed: number;
  unsigned: number;
  keyPresent: boolean;
  problems: string[];
};

/**
 * Re-walk the chain: seq continuity, prev_hash linking, and (when a key
 * exists) ed25519 signatures. Key deletion is BROKEN, not unsigned:
 * signed entries with no local pubkey fail, and stripping sigs to launder
 * breaks nothing locally — so export (which carries pubkey + chain_tail)
 * is the external anchor. Truncating the tail is invisible locally;
 * middle deletion fails via seq/prev_hash.
 */
export function verifyChain(cwd: string): AuditVerification {
  const { entries, parseErrors } = readAuditLog(cwd);
  const problems: string[] = parseErrors.map((e) => `parse error: ${e}`);
  const pub = loadPublicKey(cwd);
  const privExists = (() => {
    try {
      fs.accessSync(path.join(cwd, ".codewhip", "key"));
      return true;
    } catch {
      return false;
    }
  })();
  const keyPresent = pub !== null;
  if (!keyPresent && privExists) {
    problems.push("key deleted: private key present without pubkey — chain BROKEN");
  }
  let expectedSeq = 1;
  let expectedPrev = "";
  let signed = 0;
  let unsigned = 0;
  for (const e of entries) {
    if (e.seq !== expectedSeq) {
      problems.push(`seq mismatch: expected ${expectedSeq}, got ${e.seq}`);
    }
    if (e.prev_hash !== expectedPrev) {
      problems.push(`seq ${e.seq}: prev_hash does not chain`);
    }
    const h = entryHash(e);
    if (e.sig === null || e.sig.length === 0) {
      unsigned += 1;
      if (keyPresent) {
        problems.push(`seq ${e.seq}: entry unsigned while a key exists`);
      }
    } else {
      signed += 1;
      if (pub === null) {
        problems.push(`seq ${e.seq}: signature present but no pubkey — key deleted, chain BROKEN`);
      } else if (
        !edVerify(
          null,
          Buffer.from(h, "utf8"),
          pub,
          Buffer.from(e.sig as string, "hex")
        )
      ) {
        problems.push(`seq ${e.seq}: signature invalid`);
      }
    }
    expectedPrev = h;
    expectedSeq += 1;
  }
  return {
    valid: problems.length === 0,
    total: entries.length,
    signed,
    unsigned,
    keyPresent,
    problems,
  };
}

type AuditBundle = {
  v: 1;
  ts: string;
  pubkey: string | null;
  chain_tail: string;
  entries: AuditEntry[];
  bundle_sig: string | null;
};

/**
 * Content-addressed signed bundle for an external auditor: all entries plus
 * the chain tail (hash of the last entry) and the local public key, signed
 * as one blob. Refuses a chain that fails to parse OR fails verify —
 * a signed bundle over a broken chain is false proof, so export gates on both.
 */
export function buildBundle(cwd: string): { bundle: AuditBundle; json: string } | { error: string } {
  const { entries, parseErrors } = readAuditLog(cwd);
  if (parseErrors.length > 0) {
    return { error: `refusing to export a broken chain: ${parseErrors[0]}` };
  }
  const v = verifyChain(cwd);
  if (!v.valid) {
    return { error: `refusing to export a broken chain: ${v.problems[0] ?? "verify failed"}` };
  }
  const pubkeyRaw = loadPublicKey(cwd);
  const base = {
    v: 1 as const,
    ts: new Date().toISOString(),
    pubkey: pubkeyRaw === null ? null : (pubkeyRaw.export({ type: "spki", format: "pem" }) as string),
    chain_tail: entries.length === 0 ? "" : entryHash(entries[entries.length - 1] as AuditEntry),
    entries,
  };
  const priv = loadPrivateKey(cwd);
  const bundle: AuditBundle = {
    ...base,
    bundle_sig: priv === null ? null : signBlob(cwd, canonicalJson(base)),
  };
  return { bundle, json: JSON.stringify(bundle) };
}