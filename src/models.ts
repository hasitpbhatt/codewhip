import { modelsUrlFor } from "./provider.js";
import { getProviderConfig } from "./custom-providers.js";

const MODELS_TIMEOUT_MS = 15000;

/** Agency verdicts are earned by live probes, not by the listing endpoint. */
export type AgencyTag = "agent" | "agent (reasoning)" | "completion-only" | "non-chat" | "untested";

export type AnnotatedModel = {
  id: string;
  tag: AgencyTag;
  note: string;
  isDefault: boolean;
};

/** Prefix rules distilled from docs + live probes. Evidence dates are set
 *  only when a probe actually exercised the tool loop; everything else says
 *  "untested" honestly (a listing endpoint cannot prove agency). */
export function annotateModel(provider: string, id: string): { tag: AgencyTag; note: string } {
  const def = getProviderConfig(provider)?.defaultModel;
  if (provider === "nvidia") {
    if (id === def) {
      return { tag: "agent", note: "codewhip default; ran the tool loop in testing (2026-09-08)" };
    }
    return { tag: "untested", note: "served; agency unknown" };
  }
  if (provider === "alibaba") {
    if (id.startsWith("qwen")) {
      return {
        tag: "untested",
        note: id === def
          ? "codewhip default; documented tool-caller, no live probe yet"
          : "documented tool-caller, no live probe yet",
      };
    }
    return { tag: "untested", note: "served; agency unknown" };
  }
  if (provider === "sensenova") {
    return {
      tag: "untested",
      note: id === def
        ? "codewhip default; agency unknown (no live probe yet)"
        : "served; agency unknown",
    };
  }
  if (provider === "llm7") {
    return {
      tag: "untested",
      note: id === def
        ? "llm7 gateway default; OpenAI-compatible, no live probe yet"
        : "served via llm7 gateway; agency unknown",
    };
  }
  if (provider === "tokenharbor") {
    return {
      tag: "untested",
      note: id === def
        ? "tokenharbor orchestrator default; OpenAI-compatible, no live probe yet"
        : "served via tokenharbor gateway; agency unknown",
    };
  }
  if (id.includes("embed")) return { tag: "non-chat", note: "embeddings only" };
  if (id.startsWith("mistral-ocr")) return { tag: "non-chat", note: "ocr only" };
  if (id.startsWith("mistral-moderation")) return { tag: "non-chat", note: "moderation only" };
  if (id.startsWith("voxtral")) return { tag: "non-chat", note: "audio only" };
  if (id.startsWith("codestral")) return { tag: "completion-only", note: "serves but refused file agency when probed (2026-09-10)" };
  if (id.startsWith("ministral")) {
    return id.endsWith("14b-latest")
      ? { tag: "agent", note: "small/fast family; tool loop probed on 14b (2026-09-10)" }
      : { tag: "agent", note: "small/fast family; documented tool-caller" };
  }
  // mistral-small/medium/magistral: vendor-documented tool-callers but the
  // free tier 429'd all live loops today — gated to "untested" until a probe
  // clears, not marketing-grade "agent".
  if (id.startsWith("mistral-small")) {
    return id === def
      ? { tag: "untested", note: "codewhip default; documented tool-caller, live probes 429-gated (2026-09-10)" }
      : { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" };
  }
  if (id.startsWith("mistral-medium")) return { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" };
  if (id.startsWith("magistral")) return { tag: "untested", note: "reasoning family; 429-gated, no live probe (2026-09-10)" };
  return { tag: "untested", note: "served; agency unknown" };
}

export type ModelsResult =
  | { ok: true; models: AnnotatedModel[] }
  | { ok: false; error: string };

function defaultFor(provider: string): string {
  return getProviderConfig(provider)?.defaultModel ?? "";
}

/** One read-only listing call. Never throws — failures return a string. */
export async function listModels(provider: string, apiKey: string): Promise<ModelsResult> {
  if (apiKey.length === 0) {
    return { ok: false, error: "missing api key" };
  }
  const cfg = getProviderConfig(provider);
  if (cfg === null) {
    return { ok: false, error: `unknown provider "${provider}" (see: codewhip provider list)` };
  }
  const url = modelsUrlFor(cfg);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `${provider} models listing timed out after ${MODELS_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `network error: ${err instanceof Error ? err.message : "fetch failed"}` };
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `invalid ${provider} key (never printed or logged)` };
    }
    if (res.status === 429) {
      return { ok: false, error: `${provider} rate limited — the listing shares your quota, retry later` };
    }
    return { ok: false, error: `${provider} models listing failed (http ${res.status})` };
  }
  let data: unknown;
  try {
    data = (await res.json()) as unknown;
  } catch {
    return { ok: false, error: `${provider} models listing returned invalid JSON` };
  }
  const rows = (data as { data?: unknown }).data;
  if (!Array.isArray(rows)) {
    return { ok: false, error: `${provider} models listing returned an unexpected shape` };
  }
  const ids = [...new Set(rows.flatMap((r) => (typeof (r as { id?: unknown }).id === "string" ? [(r as { id: string }).id] : [])))].sort();
  const fallback = defaultFor(provider);
  return {
    ok: true,
    models: ids.map((id) => ({ id, ...annotateModel(provider, id), isDefault: id === fallback })),
  };
}
