import { describe, it, expect, vi, beforeEach } from "vitest";

const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly body?: string) { super(message); }
  },
  basicAuth: (s: string) => s,
}));

const { GeminiAdapter, parseGuess } = await import("../server/src/adapters/gemini.js");

const cfg = { baseUrl: "", secret: "TESTKEY" };

/** A generateContent response carrying `obj` as the model's JSON answer. */
const reply = (obj: unknown) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

beforeEach(() => httpJson.mockReset());

describe("GeminiAdapter wiring", () => {
  it("sends the key as a header, never in the URL", async () => {
    // Query strings end up in logs and proxies; an API key must not.
    httpJson.mockResolvedValueOnce({ models: [] });
    await new GeminiAdapter(cfg).models().catch(() => {});
    const [, path, opts] = httpJson.mock.calls[0];
    expect(opts.headers).toEqual({ "x-goog-api-key": "TESTKEY" });
    expect(path).not.toContain("TESTKEY");
    expect(JSON.stringify(opts.query ?? {})).not.toContain("TESTKEY");
  });

  it("falls back to Google's endpoint when no base URL is configured", async () => {
    httpJson.mockResolvedValueOnce({ models: [] });
    await new GeminiAdapter({ baseUrl: "  ", secret: "k" }).models();
    expect(httpJson.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com");
  });

  it("uses the configured model, and a sane default without one", () => {
    expect(new GeminiAdapter(cfg).model).toBe("gemini-2.5-flash");
    expect(new GeminiAdapter({ ...cfg, extra: { model: "gemini-3-pro" } }).model).toBe("gemini-3-pro");
    // A blank field means "the default", not a request for a model named "".
    expect(new GeminiAdapter({ ...cfg, extra: { model: "   " } }).model).toBe("gemini-2.5-flash");
  });

  it("asks for deterministic, schema-constrained JSON", async () => {
    httpJson.mockResolvedValueOnce(reply({ kind: "movie", title: "Dune", confidence: 0.9 }));
    await new GeminiAdapter(cfg).identify("Dune.2021.1080p");
    const opts = httpJson.mock.calls[0][2];
    expect(opts.method).toBe("POST");
    // Identification is not creative: the same name must give the same answer.
    expect(opts.body.generationConfig.temperature).toBe(0);
    expect(opts.body.generationConfig.responseMimeType).toBe("application/json");
    expect(opts.body.generationConfig.responseSchema).toBeDefined();
  });
});

describe("GeminiAdapter.health", () => {
  it("names a configured model the key cannot actually reach", async () => {
    // Otherwise this is a cheerful "healthy" that 404s on the first real call.
    httpJson.mockResolvedValueOnce({
      models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
    });
    const h = await new GeminiAdapter({ ...cfg, extra: { model: "gemini-9-imaginary" } }).health();
    expect(h.healthy).toBe(false);
    expect(h.detail).toMatch(/not available to this key/);
    expect(h.detail).toMatch(/gemini-2\.5-flash/); // and says what it could use
  });

  it("is healthy when the configured model is present", async () => {
    httpJson.mockResolvedValueOnce({
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      ],
    });
    const h = await new GeminiAdapter(cfg).health();
    expect(h.healthy).toBe(true);
    expect(h.version).toBe("gemini-2.5-flash");
  });

  it("ignores models that cannot answer a generateContent call", async () => {
    // An embedding model is not a usable model here, so a key that can reach
    // only those has none — and says so, rather than naming an alternative it
    // does not in fact have.
    httpJson.mockResolvedValueOnce({
      models: [{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }],
    });
    const h = await new GeminiAdapter(cfg).health();
    expect(h.healthy).toBe(false);
    expect(h.detail).toMatch(/can use no models/);
  });

  it("counts a model that does not declare its methods as usable", async () => {
    // Older list responses omit supportedGenerationMethods; treating that as
    // "unusable" would report a working key as broken.
    httpJson.mockResolvedValueOnce({ models: [{ name: "models/gemini-2.5-flash" }] });
    expect((await new GeminiAdapter(cfg).health()).healthy).toBe(true);
  });
});

describe("parseGuess — the model's answer is validated, not trusted", () => {
  it("reads a well-formed guess", () => {
    expect(parseGuess(reply({ kind: "tv", title: "Severance", year: 2022, season: 2, confidence: 0.8 })))
      .toMatchObject({ kind: "tv", title: "Severance", year: 2022, season: 2, confidence: 0.8 });
  });

  it("treats an honest 'unknown' as no answer", () => {
    // A refusal is useful. Converting it into a guess would not be.
    expect(parseGuess(reply({ kind: "unknown", title: "something", confidence: 0.9 }))).toBeNull();
  });

  it("rejects an answer with no title", () => {
    expect(parseGuess(reply({ kind: "movie", title: "   ", confidence: 1 }))).toBeNull();
  });

  it("drops an implausible year rather than passing it on", () => {
    expect(parseGuess(reply({ kind: "movie", title: "X", year: 12, confidence: 0.5 }))?.year).toBeUndefined();
  });

  it("turns an unusable confidence into no opinion, never into certainty", () => {
    expect(parseGuess(reply({ kind: "movie", title: "X", confidence: 42 }))?.confidence).toBe(0.5);
    expect(parseGuess(reply({ kind: "movie", title: "X" }))?.confidence).toBe(0.5);
  });

  it("ignores a season on anything that is not TV", () => {
    expect(parseGuess(reply({ kind: "movie", title: "X", season: 3, confidence: 0.9 }))?.season).toBeUndefined();
  });

  it("survives a blocked, empty or non-JSON response", () => {
    expect(parseGuess({ candidates: [] })).toBeNull();
    expect(parseGuess({})).toBeNull();
    expect(parseGuess(null)).toBeNull();
    expect(parseGuess({ candidates: [{ content: { parts: [{ text: "I'm sorry, I can't." }] } }] })).toBeNull();
  });
});
