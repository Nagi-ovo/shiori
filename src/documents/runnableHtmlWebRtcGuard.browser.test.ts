import "../test/setupDom";
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { browserFixture, browserModes, browserRoutes, type BrowserProbe } from "../test/runnableHtmlBrowserFixtures";

// Browser execution is opt-in; happy-dom cannot establish first-script timing.
// Reproduce: SHIORI_BROWSER_TEST=1 B027_PHASE=green bun test src/documents/runnableHtmlWebRtcGuard.browser.test.ts
// Override SHIORI_CHROME for another Chromium executable. Reports + rendered
// DOM + fixture + invocation are persisted under test-artifacts/b027/<phase>/.
const enabled = process.env.SHIORI_BROWSER_TEST === "1";
const chrome = process.env.SHIORI_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KNOWN_OPEN = new Set(["parserOpenShadow", "adoptedOpenShadow", "adoptedClosedShadow"]);
let reports: BrowserProbe[] = [];
let missing: string[] = [];

describe.skipIf(!enabled)("run frame WebRTC first-script isolation in Chromium", () => {
  beforeAll(async () => {
    const directory = resolve("test-artifacts/b027", process.env.B027_PHASE ?? "latest");
    await mkdir(directory, { recursive: true });
    const fixture = browserFixture();
    const fixturePath = resolve(directory, "fixture.html");
    await Bun.write(fixturePath, fixture.html);
    await Bun.write(resolve(directory, "README.txt"),
      "SHIORI_BROWSER_TEST=1 B027_PHASE=" + (process.env.B027_PHASE ?? "latest") +
      " bun test src/documents/runnableHtmlWebRtcGuard.browser.test.ts\n" +
      "Uses installed Chromium, opaque sandbox=allow-scripts frames, production buildRunnableHtml, " +
      "and each nested child's first script. Peer connections use iceServers:[] and close immediately.\n");
    const processHandle = Bun.spawn([chrome, "--headless=new", "--disable-gpu",
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      `--user-data-dir=${resolve(directory, "chrome-profile")}`,
      "--dump-dom", "--virtual-time-budget=20000", `file://${fixturePath}`],
    { stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => processHandle.kill(), 40_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text(), processHandle.exited,
    ]).finally(() => clearTimeout(deadline));
    await Bun.write(resolve(directory, "rendered.html"), stdout);
    await Bun.write(resolve(directory, "chrome.stderr.txt"), stderr);
    expect(code).toBe(0);
    const rendered = new window.DOMParser().parseFromString(stdout, "text/html");
    const result = JSON.parse(rendered.querySelector("#results")?.textContent ?? "null");
    expect(result).not.toBeNull();
    reports = result.reports;
    missing = result.missing;
    await Bun.write(resolve(directory, "report.json"), JSON.stringify({
      command: "SHIORI_BROWSER_TEST=1 bun test src/documents/runnableHtmlWebRtcGuard.browser.test.ts",
      executable: chrome, browser: result.browser, reports, missing,
    }, null, 2));
  }, 60_000);

  for (const mode of browserModes) {
    test(`${mode}: unguarded control executes and constructs a peer`, () => {
      const report = reports.find((entry) => entry.id === `${mode}:unguarded-control`);
      expect(report?.complete).toBe(true);
      expect(report?.constructed).toContain("RTCPeerConnection");
    });
    test(`${mode}: frame-src none still allows a srcdoc child to construct a peer`, () => {
      const report = reports.find((entry) => entry.id === `${mode}:frame-src-none-control`);
      expect(report?.complete).toBe(true);
      expect(report?.constructed).toContain("RTCPeerConnection");
    });
    for (const route of Object.keys(browserRoutes)) {
      // Still open (B027): these pass once the guard covers them, and then
      // test.failing turns red until the route moves out of this set.
      const run = KNOWN_OPEN.has(route) ? test.failing : test;
      run(`${mode}: ${route} blocks WebRTC before the child's first script`, () => {
        const id = `${mode}:${route}`;
        expect(missing).not.toContain(id);
        const report = reports.find((entry) => entry.id === id);
        expect(report?.complete).toBe(true);
        expect(report?.routeError).toBeUndefined();
        expect(report?.available).toEqual([]);
        expect(report?.constructed).toEqual([]);
      });
    }
  }
});
