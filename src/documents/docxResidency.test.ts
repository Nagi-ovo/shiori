import { describe, expect, test } from "bun:test";
import { suspendInactiveDocxTabs } from "./docxResidency";

describe("DOCX residency", () => {
  test("releases cached bytes for every inactive Word tab", () => {
    const activeBytes = new Uint8Array([1]);
    const inactiveBytes = new Uint8Array([2]);
    const tabs = suspendInactiveDocxTabs(
      [
        {
          id: "active",
          kind: "docx" as const,
          source: { type: "cache" as const, id: "active-source" },
          status: "loaded",
          bytes: activeBytes,
        },
        {
          id: "inactive",
          kind: "docx" as const,
          source: { type: "cache" as const, id: "inactive-source" },
          status: "loaded",
          bytes: inactiveBytes,
        },
      ],
      "active",
    );

    expect(tabs[0]?.bytes).toBe(activeBytes);
    expect(tabs[0]?.status).toBe("loaded");
    expect(tabs[1]?.bytes).toBeUndefined();
    expect(tabs[1]?.status).toBe("suspended");
  });

  test("does not discard an ephemeral tab that cannot be reloaded", () => {
    const bytes = new Uint8Array([1]);
    const [tab] = suspendInactiveDocxTabs(
      [
        {
          id: "ephemeral",
          kind: "docx" as const,
          source: { type: "ephemeral" as const },
          status: "loaded",
          bytes,
        },
      ],
      null,
    );
    expect(tab?.bytes).toBe(bytes);
    expect(tab?.status).toBe("loaded");
  });
});
