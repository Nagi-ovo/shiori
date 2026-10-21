import type { ServerResponse } from "node:http";
import { describe, expect, test } from "bun:test";
import { getLiveAppContext } from "../src/liveApp";
import { withFixture } from "./liveAppHarness";

describe("live API transport", () => {
  test("hangs up on a response that is not JSON, even while it keeps streaming", async () => {
    // Rejecting is not enough: the hard deadline is cleared once the request
    // settles, and the idle timeout never fires on a peer that keeps sending,
    // so a socket left open would keep the CLI process alive after it had
    // already reported the error.
    let stream: ReturnType<typeof setInterval> | undefined;
    let served: ServerResponse | undefined;
    let hungUp!: () => void;
    const closed = new Promise<"closed">((resolve) => {
      hungUp = () => resolve("closed");
    });
    await withFixture(
      (_request, response) => {
        served = response;
        response.on("close", hungUp);
        response.writeHead(200, { "Content-Type": "text/plain" });
        stream = setInterval(() => response.write("x".repeat(1024)), 5);
      },
      async ({ descriptorPath }) => {
        try {
          await expect(
            getLiveAppContext({ descriptorPath }),
          ).rejects.toMatchObject({
            code: "ERR_APP_UNAVAILABLE",
            message: "Shiori live API did not return JSON",
          });
          const outcome = await Promise.race([
            closed,
            new Promise<"open">((resolve) =>
              setTimeout(() => resolve("open"), 1_000),
            ),
          ]);
          expect(outcome).toBe("closed");
        } finally {
          // Before the fixture closes its server, which would otherwise wait
          // on a socket the client never let go of.
          clearInterval(stream);
          served?.destroy();
        }
      },
    );
  });
});
