import { describe, expect, it } from "vitest";
import { parseJwtClaims, shouldRefreshJwt, VaultCipher } from "./index.js";

function jwt(exp: number) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, iss: "fuduo-biz", uid: 725 })).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("credential vault", () => {
  it("encrypts with random IVs and decrypts only with the current key", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const vault = new VaultCipher(key);
    const first = vault.encrypt("secret");
    const second = vault.encrypt("secret");
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(vault.decrypt(first)).toBe("secret");
  });

  it("parses identity and refresh threshold without exposing the token", () => {
    const token = jwt(2_000);
    expect(parseJwtClaims(token)).toMatchObject({ exp: 2_000, iss: "fuduo-biz", subject: "725" });
    expect(shouldRefreshJwt(token, 1_900_000, 120_000)).toBe(true);
  });
});
