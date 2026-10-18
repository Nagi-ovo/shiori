import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import {
  hasAgentCli,
  normalizeAgentCliAvailability,
} from "./agentCli";

describe("agent CLI availability", () => {
  test("accepts either supported local agent", () => {
    expect(hasAgentCli(normalizeAgentCliAvailability({ claudeCode: true }))).toBe(
      true,
    );
    expect(hasAgentCli(normalizeAgentCliAvailability({ codex: true }))).toBe(
      true,
    );
  });

  test("fails closed on malformed native results", () => {
    expect(normalizeAgentCliAvailability(null)).toEqual({
      claudeCode: false,
      codex: false,
    });
    expect(
      normalizeAgentCliAvailability({ claudeCode: "yes", codex: 1 }),
    ).toEqual({ claudeCode: false, codex: false });
  });
});
