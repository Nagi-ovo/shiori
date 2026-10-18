import { describe, expect, test } from "bun:test";
import { isWebPanelUrl, resolveAddressBarInput } from "./webPanelUrl";

describe("isWebPanelUrl", () => {
  test("accepts http and https", () => {
    expect(isWebPanelUrl("https://github.com")).toBe(true);
    expect(isWebPanelUrl("http://example.com/path?q=1")).toBe(true);
    expect(isWebPanelUrl("  https://leading-space.com ")).toBe(true);
    expect(isWebPanelUrl("HTTPS://UPPER.example")).toBe(true);
  });

  test("rejects non-web schemes and bare text", () => {
    expect(isWebPanelUrl("mailto:a@b.com")).toBe(false);
    expect(isWebPanelUrl("file:///tmp/x.pdf")).toBe(false);
    expect(isWebPanelUrl("tel:+123")).toBe(false);
    expect(isWebPanelUrl("github.com")).toBe(false);
    expect(isWebPanelUrl("./file.pdf")).toBe(false);
  });
});

describe("resolveAddressBarInput", () => {
  test("passes through http(s) URLs unchanged", () => {
    expect(resolveAddressBarInput("https://example.com/x")).toBe(
      "https://example.com/x",
    );
    expect(resolveAddressBarInput("  http://a.test  ")).toBe("http://a.test");
  });

  test("resolves bare hosts with local dev hosts on http", () => {
    expect(resolveAddressBarInput("example.com")).toBe("https://example.com");
    expect(resolveAddressBarInput("github.com/Nagi-ovo")).toBe(
      "https://github.com/Nagi-ovo",
    );
    expect(resolveAddressBarInput("localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(resolveAddressBarInput("localhost")).toBe("http://localhost");
    expect(resolveAddressBarInput("127.0.0.1:5173")).toBe(
      "http://127.0.0.1:5173",
    );
    expect(resolveAddressBarInput("[::1]:8080")).toBe("http://[::1]:8080");
  });

  test("rejects other explicit schemes", () => {
    expect(resolveAddressBarInput("mailto:a@b.com")).toBeNull();
    expect(resolveAddressBarInput("file:///tmp/x")).toBeNull();
  });

  test("treats free text as a Google search", () => {
    expect(resolveAddressBarInput("shiori pdf editor")).toBe(
      "https://www.google.com/search?q=shiori%20pdf%20editor",
    );
  });

  test("returns null for empty input", () => {
    expect(resolveAddressBarInput("")).toBeNull();
    expect(resolveAddressBarInput("   ")).toBeNull();
  });
});
