import { describe, it, expect } from "vitest";
import { mergeExtra, safeExtra, hasExtraConfig } from "../server/src/config/extra.js";

describe("typed extra config: mergeExtra", () => {
  it("coerces and stores a Kavita libraryId", () => {
    expect(mergeExtra("kavita", { libraryId: "3" }, {})).toEqual({ libraryId: 3 });
  });
  it("clears an omitted non-secret field (libraryId)", () => {
    expect(mergeExtra("kavita", {}, { libraryId: 3 })).toEqual({});
  });
  it("stores a submitted slskd webhook token", () => {
    expect(mergeExtra("slskd", { webhookToken: "supersecrettoken" }, {})).toEqual({ webhookToken: "supersecrettoken" });
  });
  it("retains an existing webhook token when the save omits it (write-only)", () => {
    expect(mergeExtra("slskd", {}, { webhookToken: "keepme12" })).toEqual({ webhookToken: "keepme12" });
    expect(mergeExtra("slskd", { webhookToken: "" }, { webhookToken: "keepme12" })).toEqual({ webhookToken: "keepme12" });
  });
  it("rejects an invalid (too short) webhook token", () => {
    expect(() => mergeExtra("slskd", { webhookToken: "short" }, {})).toThrow();
  });
  it("ignores extra for kinds without a schema", () => {
    expect(mergeExtra("radarr", { anything: 1 }, {})).toEqual({});
    expect(hasExtraConfig("radarr")).toBe(false);
    expect(hasExtraConfig("slskd")).toBe(true);
  });
});

describe("typed extra config: safeExtra never leaks secrets", () => {
  it("projects a secret field to a boolean flag", () => {
    expect(safeExtra("slskd", { webhookToken: "x" })).toEqual({ webhookTokenSet: true });
    expect(safeExtra("slskd", {})).toEqual({ webhookTokenSet: false });
  });
  it("passes non-secret fields through", () => {
    expect(safeExtra("kavita", { libraryId: 3 })).toEqual({ libraryId: 3 });
  });
});
