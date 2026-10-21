import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  isWebPanelHandoffUrl,
  isWebPanelUrl,
  resolveAddressBarInput,
  WEB_PANEL_HANDOFF_SCHEMES,
} from "./webPanelUrl";

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

describe("isWebPanelHandoffUrl", () => {
  // The links a page in the panel may hand to another app once the user
  // agrees: mail and calls everywhere, plus the messaging, FaceTime and map
  // links the tablet plugins used to open before the consent prompt existed.
  test("hands off communication and map links", () => {
    for (const url of [
      "mailto:a@b.com",
      "MAILTO:A@B.COM",
      "tel:+44123",
      "sms:+44123?body=hi",
      "smsto:+44123",
      "geo:51.5,-0.1?q=Imperial",
      "facetime:a@b.com",
      "facetime-audio:+44123",
      "maps:?q=London",
    ]) {
      expect(isWebPanelHandoffUrl(url)).toBe(true);
    }
  });

  test("never hands off local files, app intents or script", () => {
    for (const url of [
      "file:///etc/passwd",
      "intent://scan/#Intent;scheme=zxing;end",
      "javascript:alert(1)",
      "shiori://open",
      "https://example.com",
      "mailto",
      " sms:+44123",
    ]) {
      expect(isWebPanelHandoffUrl(url)).toBe(false);
    }
  });

  // The opener plugin refuses, on the device and silently to the user, a
  // URL outside its scope. Its default scope covers only mailto: and tel:,
  // so every other hand-off scheme needs its own entry in the mobile
  // capability.
  test("the mobile capability lets the opener open every hand-off scheme", () => {
    const capability = JSON.parse(
      readFileSync(
        new URL("../../src-tauri/capabilities/mobile.json", import.meta.url),
        "utf8",
      ),
    ) as { permissions: Array<string | { identifier: string; allow?: { url: string }[] }> };
    const scoped = new Set<string>();
    if (capability.permissions.includes("opener:allow-default-urls")) {
      scoped.add("mailto:*");
      scoped.add("tel:*");
    }
    for (const permission of capability.permissions) {
      if (typeof permission === "string") continue;
      if (permission.identifier !== "opener:allow-open-url") continue;
      for (const entry of permission.allow ?? []) scoped.add(entry.url);
    }
    for (const scheme of WEB_PANEL_HANDOFF_SCHEMES) {
      expect(scoped.has(`${scheme}:*`)).toBe(true);
    }
  });
});
