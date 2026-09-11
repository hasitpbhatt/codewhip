import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { isWebfetchArgs, webfetchTool, webfetchOrigin, WEBFETCH_TIMEOUT_MS } from "./webfetch.js";

type StubRes = {
  ok: boolean;
  status: number;
  url: string;
  contentLength: string | null;
  body: string;
};

function stubFetch(res: StubRes, onCall?: () => void): () => void {
  const real = globalThis.fetch;
  const fn = (): Promise<Response> => {
    onCall?.();
    return Promise.resolve({
      ok: res.ok,
      status: res.status,
      url: res.url,
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? res.contentLength : null) },
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(res.body).buffer as ArrayBuffer),
    } as unknown as Response);
  };
  globalThis.fetch = fn as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const OK_PAGE: StubRes = {
  ok: true,
  status: 200,
  url: "https://docs.example.com/guide",
  contentLength: null,
  body: "<html><head><title>T</title><script>evil()</script><style>.x{}</style></head><body><h1>Fish &amp; Chips</h1><p>hello <b>world</b></p></body></html>",
};

describe("webfetch", () => {
  it("isWebfetchArgs guards the shape", () => {
    strictEqual(isWebfetchArgs({ url: "https://x.example" }), true);
    strictEqual(isWebfetchArgs({ url: "https://x.example", format: "html" }), true);
    strictEqual(isWebfetchArgs({}), false);
    strictEqual(isWebfetchArgs({ url: 42 }), false);
    strictEqual(isWebfetchArgs(null), false);
  });
  it("webfetchOrigin keeps https origins only", () => {
    strictEqual(webfetchOrigin("https://docs.example.com/a?x=1"), "https://docs.example.com");
    strictEqual(webfetchOrigin("http://docs.example.com/"), null);
    strictEqual(webfetchOrigin("ftp://docs.example.com/"), null);
    strictEqual(webfetchOrigin("not a url"), null);
  });
  it("refuses non-https without touching the network", async () => {
    let calls = 0;
    const restore = stubFetch(OK_PAGE, () => {
      calls += 1;
    });
    try {
      for (const url of ["http://docs.example.com/x", "ftp://docs.example.com/x", "file:///etc/passwd"]) {
        const r = await webfetchTool({ cwd: "/tmp" }, { url });
        strictEqual(r.ok, false);
        ok(r.output.includes("https://"));
      }
      strictEqual(calls, 0);
    } finally {
      restore();
    }
  });
  it("validates args before fetching", async () => {
    strictEqual((await webfetchTool({ cwd: "/tmp" }, { url: "   " })).ok, false);
    strictEqual((await webfetchTool({ cwd: "/tmp" }, { url: "https://x.example", format: "pdf" })).ok, false);
  });
  it("strips markup, scripts, and decodes entities in text mode", async () => {
    const restore = stubFetch(OK_PAGE);
    try {
      const r = await webfetchTool({ cwd: "/tmp" }, { url: "https://docs.example.com/guide" });
      strictEqual(r.ok, true);
      ok(r.output.includes("Fish & Chips"));
      ok(r.output.includes("hello world"));
      ok(!r.output.includes("<"));
      ok(!r.output.includes("evil()"));
    } finally {
      restore();
    }
  });
  it("passes HTML through in html mode", async () => {
    const restore = stubFetch(OK_PAGE);
    try {
      const r = await webfetchTool({ cwd: "/tmp" }, { url: "https://docs.example.com/guide", format: "html" });
      strictEqual(r.ok, true);
      ok(r.output.includes("<h1>"));
    } finally {
      restore();
    }
  });
  it("refuses redirects that leave https", async () => {
    const restore = stubFetch({ ...OK_PAGE, url: "http://docs.example.com/guide" });
    try {
      const r = await webfetchTool({ cwd: "/tmp" }, { url: "https://docs.example.com/guide" });
      strictEqual(r.ok, false);
      ok(r.output.includes("redirect"));
      ok(!r.output.includes("http://docs.example.com/guide"));
    } finally {
      restore();
    }
  });
  it("reports HTTP errors without keeping content", async () => {
    const restore = stubFetch({ ...OK_PAGE, ok: false, status: 404 });
    try {
      const r = await webfetchTool({ cwd: "/tmp" }, { url: "https://docs.example.com/missing" });
      strictEqual(r.ok, false);
      ok(r.output.includes("404"));
      ok(!r.output.includes("missing"));
    } finally {
      restore();
    }
  });
  it("refuses oversize bodies by header and by bytes", async () => {
    let restore = stubFetch({ ...OK_PAGE, contentLength: String(2 * 1024 * 1024) });
    try {
      strictEqual((await webfetchTool({ cwd: "/tmp" }, { url: "https://docs.example.com/big" })).ok, false);
    } finally {
      restore();
    }
    restore = stubFetch({ ...OK_PAGE, body: "x".repeat(2 * 1024 * 1024) });
    try {
      const r = await webfetchTool({ cwd: "/tmp" }, { url: "https://docs.example.com/big" });
      strictEqual(r.ok, false);
      ok(r.output.includes("1MB"));
    } finally {
      restore();
    }
  });
  it("a killed signal reports killed, never throws", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    try {
      const ctrl = new AbortController();
      ctrl.abort();
      const r = await webfetchTool({ cwd: "/tmp" }, { url: "https://docs.example.com/slow" }, ctrl.signal);
      strictEqual(r.ok, false);
      strictEqual(r.output, "webfetch: killed");
    } finally {
      globalThis.fetch = real;
    }
  });
  it("timeout constant stays within the tool wall-clock budget", () => {
    strictEqual(WEBFETCH_TIMEOUT_MS, 30000);
  });
});
