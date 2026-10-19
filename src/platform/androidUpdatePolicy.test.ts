import { describe, expect, test } from "bun:test";
import {
  requireDirectAndroidSha256,
  requireOfficialDirectAndroidUpdateUrl,
} from "./androidUpdatePolicy";

const OFFICIAL_URL =
  "https://github.com/Nagi-ovo/shiori/releases/download/v26.10.1/Shiori.apk";

describe("direct Android update policy", () => {
  test("requires a complete SHA-256 digest", () => {
    const digest = "A".repeat(64);
    expect(requireDirectAndroidSha256(digest)).toBe("a".repeat(64));
    for (const invalid of [
      "http://github.com/Nagi-ovo/shiori/releases/download/v1/Shiori.apk",
      "https://github.com.evil.test/Nagi-ovo/shiori/releases/download/v1/Shiori.apk",
      "https://github.com/other/shiori/releases/download/v1/Shiori.apk",
      "https://github.com/Nagi-ovo/shiori/releases/download/v1/Shiori.exe",
      `${OFFICIAL_URL}?redirect=https://evil.test`,
      "https://github.com/Nagi-ovo/some-fork/releases/download/v1/Shiori.apk",
      // The repo's name before its rename: this build asks /api/release for
      // the current path (updater.ts), so the old one is no longer official.
      "https://github.com/Nagi-ovo/shiori-releases/releases/download/v1/Shiori.apk",
    ]) {
      expect(() => requireOfficialDirectAndroidUpdateUrl(invalid)).toThrow(
        "android-update-url-not-allowed",
      );
    }
  });
});
