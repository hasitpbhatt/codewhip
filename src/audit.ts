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
 * Append one entry to the chain. Returns null on success, or a reason string
 * on failure (never throws) — the loop surfaces non-null in the run summary
 * and the outcome record instead of silently shedding history. Reads the
 * tail to derive `seq` and `prev_hash`, so sequences are global across runs.
 *
 * Hardened (P0): mkdir-lock against concurrent-run seq forks, plus fsync per
 * append so a crash loses at most one entry — never the whole buffered trail
 * (loop flushes per call). The spin budget EXCEEDS the stale-lock threshold
 * with margin: a waiter that gives up while a live writer still holds the
 * lock either drops its entry (silently shedding history the verifier cannot
 * detect) or rmdirs a live lock and forks the seq — both worse than waiting.
 * The tail read inside the lock is O(1) (last 8KB), never a full-file walk,
 * so lock hold time does not grow with the log.
 */
const STALE_LOCK_MS = 5000;
const LOCK_SPIN_MS = STALE_LOCK_MS + 3000;

/** Last complete, well-formed entry without reading the whole file. */
function readTailEntry(cwd: string): AuditEntry | undefined {
  let raw: string;
  try {
    const st = fs.statSync(auditPath(cwd));
    if (st.size === 0) return undefined;
    const len = Math.min(st.size, 8192);
    const fd = fs.openSync(auditPath(cwd), "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      raw = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined; // missing file = empty chain
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (typeof e.seq === "number") return e;
    } catch { /* torn tail line or foreign bytes — keep walking back */ }
  }
  return undefined;
}

export function appendEntry(cwd: string, input: AuditInput): string | null {
  const dir = path.join(cwd, ".codewhip");
  const lockDir = path.join(dir, "audit.lock");
  const deadline = Date.now() + LOCK_SPIN_MS;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch {
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) fs.rmdirSync(lockDir);
      } catch { /* lock vanished, retry */ }
      const end = Date.now() + 10 + Math.floor(Math.random() * 20);
      while (Date.now() < end) { /* bounded spin, no deps */ }
    }
  }
  if (!acquired) {
    return `audit lock not acquired within ${LOCK_SPIN_MS}ms — entry NOT recorded (concurrent run or stale lock)`;
  }
  try {
    const last = readTailEntry(cwd);
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
    return null;
  } catch (err) {
    return `audit append failed: ${err instanceof Error ? err.message : "error"}`;
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
 * Birth of the local keypair (key.pub mtime, else key mtime): the earliest
 * moment a signed entry could legitimately exist. Entries older than this
 * with null sigs are plausibly pre-key; anything newer is tampering.
 * Null when no key files exist (unsigned repos verify via `valid` alone).
 */
function keyBirthMs(cwd: string): number | null {
  for (const f of ["key.pub", "key"]) {
    try {
      return fs.statSync(path.join(cwd, ".codewhip", f)).mtimeMs;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Signed genesis marker: appended by `init` immediately after the keypair is
 * minted (and once on the repair path when a legacy chain lacks one). It
 * bounds the forgivable pre-key unsigned prefix: without a marker, an
 * attacker with filesystem write but no key can prepend fabricated unsigned
 * entries with backdated timestamps and re-chain them — sha256 linking needs
 * no secret — and verification would report INTACT on unbounded fake
 * history. With a marker, the invariant `genesis.seq === unsignedPrefix + 1`
 * is checkable: any prepend-forgery shifts the marker's seq and breaks it.
 * The marker's args/result hashes commit to the public key PEM, tying the
 * bound to this specific trust root.
 */
export function appendGenesis(cwd: string): boolean {
  let keyHash: string;
  try {
    keyHash = sha256Hex(fs.readFileSync(path.join(cwd, ".codewhip", "key.pub"), "utf8"));
  } catch {
    return false;
  }
  return appendEntry(cwd, {
    runId: "genesis",
    actor: "policy",
    tool: "genesis",
    args_hash: keyHash,
    result_hash: keyHash,
    policy: "genesis:key-created",
  }) === null;
}

/** Index of the signed genesis marker, or -1 (also -1 when it is unsigned). */
function genesisIndex(entries: AuditEntry[]): number {
  return entries.findIndex(
    (e) => e.tool === "genesis" && e.sig !== null && (e.sig as string).length > 0
  );
}

export function hasGenesis(cwd: string): boolean {
  return genesisIndex(readAuditLog(cwd).entries) !== -1;
}

/**
 * One interpretation layer, used by `audit --verify`, `demo`, and `trust` so
 * every surface reports the SAME status.
 *
 * Fail-closed on downgrade: stripping every signature produces EXACTLY the
 * "entry unsigned while a key exists" problem set, so "all unsigned" alone
 * must never mean clean. Legit pre-key history has one narrow shape — a
 * contiguous unsigned prefix bounded by a signed genesis marker at exactly
 * prefix+1 (any prepend-forgery shifts the marker and fails) — and anything
 * else is BROKEN. Residual hole (documented, not fixable locally): an attacker with full filesystem write can re-forge the
 * whole chain plus a fresh keypair; that breaks cross-references in
 * outcomes/share bundles anchored to the old pubkey and tail instead.
 */
export function interpretVerification(
  v: AuditVerification,
  cwd: string
): { clean: boolean; status: string; problems: string[] } {
  if (v.valid) return { clean: true, status: "INTACT", problems: [] };
  const unsignedOnly =
    v.problems.length > 0 &&
    v.problems.every((p) => p.includes("entry unsigned while a key exists"));
  if (unsignedOnly) {
    const { entries } = readAuditLog(cwd);
    const birth = keyBirthMs(cwd);
    let prefix = 0;
    while (
      prefix < entries.length &&
      (entries[prefix]?.sig === null || (entries[prefix]?.sig as string)?.length === 0)
    ) {
      prefix += 1;
    }
    const tailSigned = entries.slice(prefix).every(
      (e) => e.sig !== null && (e.sig as string).length > 0
    );
    const prefixPreKey =
      birth !== null &&
      entries.slice(0, prefix).every((e) => {
        const t = Date.parse(e.ts);
        return Number.isFinite(t) && t <= birth;
      });
    if (prefix >= 1 && tailSigned && prefixPreKey) {
      // Genesis marker (P0): bounds the forgivable pre-key prefix. The
      // invariant `genesis.seq === prefix + 1` is checkable — any
      // prepend-forgery (unsigned entries inserted before the signed era)
      // shifts the marker's seq and fails here. Without a marker the prefix
      // has no verifiable bound, and the status says so.
      const g = genesisIndex(entries);
      if (g === -1) {
        return {
          clean: true,
          status: `INTACT (${prefix} pre-key unsigned ${prefix === 1 ? "entry" : "entries"} pre-dating the key — no genesis marker: the unsigned prefix has no verifiable bound, run init to append one)`,
          problems: v.problems,
        };
      }
      if (g < prefix) {
        return {
          clean: false,
          status: "BROKEN",
          problems: [...v.problems, "genesis marker found but unsigned inside the pre-key prefix"],
        };
      }
      const genesis = entries[g] as AuditEntry;
      if (genesis.seq !== prefix + 1) {
        return {
          clean: false,
          status: "BROKEN",
          problems: [
            ...v.problems,
            `genesis marker at seq ${genesis.seq} but ${prefix} unsigned entries precede it — history was prepended after the signed era began`,
          ],
        };
      }
      return {
        clean: true,
        status: `INTACT (signed era starts at genesis seq ${genesis.seq}; ${prefix} pre-key unsigned ${prefix === 1 ? "entry" : "entries"} are legacy — unverifiable by construction, bounded by the marker)`,
        problems: v.problems,
      };
    }
  }
  return { clean: false, status: "BROKEN", problems: v.problems };
}

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