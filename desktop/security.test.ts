import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { createToken, isTrustedUrl, authorized } = require("./security.cjs") as {
  createToken: () => string;
  isTrustedUrl: (value: string, origin: string) => boolean;
  authorized: (
    request: { headers: Record<string, string> },
    token: string,
  ) => boolean;
};
describe("desktop local service boundary", () => {
  it("accepts only the loopback origin and prevents prefix, userinfo and scheme tricks", () => {
    const origin = "http://127.0.0.1:4055";
    expect(isTrustedUrl(`${origin}/intelligence`, origin)).toBe(true);
    for (const url of [
      "http://127.0.0.1:40550/",
      "http://127.0.0.1:4055.evil.test/",
      "https://127.0.0.1:4055/",
      "http://user@127.0.0.1:4055/",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ])
      expect(isTrustedUrl(url, origin)).toBe(false);
  });
  it("requires a fresh desktop token on every local request", () => {
    const token = createToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(createToken()).not.toBe(token);
    expect(authorized({ headers: {} }, token)).toBe(false);
    expect(
      authorized({ headers: { "x-tracefolio-desktop": "wrong" } }, token),
    ).toBe(false);
    expect(
      authorized({ headers: { "x-tracefolio-desktop": token } }, token),
    ).toBe(true);
  });
});
