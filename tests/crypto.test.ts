import { describe, it, expect } from "vitest";
import { deriveKey, encryptSecret, decryptSecret, maskSecret } from "../server/src/lib/crypto.js";
import { hashPassword, verifyPassword } from "../server/src/auth/password.js";

describe("secret encryption", () => {
  const key = deriveKey("test-master-key-please-change");
  it("round-trips an encrypted secret", () => {
    const enc = encryptSecret("super-secret-api-key", key);
    expect(enc).not.toContain("super-secret");
    expect(decryptSecret(enc, key)).toBe("super-secret-api-key");
  });
  it("fails to decrypt with the wrong key (tamper/auth)", () => {
    const enc = encryptSecret("abc", key);
    const wrong = deriveKey("different-key");
    expect(() => decryptSecret(enc, wrong)).toThrow();
  });
  it("masks secrets for display", () => {
    expect(maskSecret("abcd1234wxyz")).toMatch(/•+wxyz$/);
  });
});

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const h = await hashPassword("hunter2hunter2");
    expect(await verifyPassword("hunter2hunter2", h)).toBe(true);
  });
  it("rejects a wrong password", async () => {
    const h = await hashPassword("hunter2hunter2");
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("produces unique salts per hash", async () => {
    const a = await hashPassword("samepass123");
    const b = await hashPassword("samepass123");
    expect(a).not.toBe(b);
  });
});
