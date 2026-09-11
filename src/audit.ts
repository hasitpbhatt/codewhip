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
 */
export function appendEntry(cwd: string, input: AuditInput): boolean {
  try {
    fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
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
    fs.appendFileSync(auditPath(cwd), JSON.stringify({ ...sigBase, sig }) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
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
 * exists) ed25519 signatures. Unsigned entries are not a chain failure on
 * their own — only signed-but-invalid or key-missing-with-signatures are.
 */
export function verifyChain(cwd: string): AuditVerification {
  const { entries, parseErrors } = readAuditLog(cwd);
  const problems: string[] = parseErrors.map((e) => `parse error: ${e}`);
  const pub = loadPublicKey(cwd);
  const keyPresent = pub !== null;
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
        problems.push(`seq ${e.seq}: signature present but no .codewhip/key to check`);
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
 * as one blob. Refuses to export a chain that fails to parse.
 */
export function buildBundle(cwd: string): { bundle: AuditBundle; json: string } | { error: string } {
  const { entries, parseErrors } = readAuditLog(cwd);
  if (parseErrors.length > 0) {
    return { error: `refusing to export a broken chain: ${parseErrors[0]}` };
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
    bundle_sig:
      priv === null
        ? null
        : edSign(null, Buffer.from(canonicalJson(base), "utf8"), priv).toString("hex"),
  };
  return { bundle, json: JSON.stringify(bundle) };
}