import { describe, expect, test } from "bun:test";
import tauriConf from "../../src-tauri/tauri.conf.json";
import { UPDATES_URL, WEBSITE_URL } from "./links";

// tauri.conf.json cannot import the constants, so it names the hosts again.
// A host moved in links.ts alone leaves the updater polling the old one, and
// a host missing from connect-src is refused by the CSP without an error the
// user ever sees.
describe("tauri.conf.json agrees with src/shared/links.ts", () => {
  test("the updater manifest lives under UPDATES_URL", () => {
    const endpoints = tauriConf.plugins.updater.endpoints;
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(endpoint.startsWith(`${UPDATES_URL}/`)).toBe(true);
    }
  });

  test("the CSP lets the app reach the update and website hosts", () => {
    const connectSrc = tauriConf.app.security.csp
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === "connect-src");
    expect(connectSrc).toContain(UPDATES_URL);
    expect(connectSrc).toContain(WEBSITE_URL);
  });
});
