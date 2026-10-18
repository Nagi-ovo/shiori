import { describe, expect, test } from "bun:test";
import { detectFormFactor } from "./formFactor";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_LEGACY =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_SPOOF =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
const ANDROID_TABLET_NO_MOBILE =
  "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

describe("detectFormFactor", () => {
  test("iPhone is a phone, not a tablet", () => {
    expect(
      detectFormFactor({
        userAgent: IPHONE,
        platform: "iPhone",
        maxTouchPoints: 5,
        screenMinSide: 390,
        isAndroid: false,
        isIos: true,
      }),
    ).toEqual({ isTablet: false, isPhone: true });
  });

  test("iPad with legacy iPad UA is a tablet", () => {
    expect(
      detectFormFactor({
        userAgent: IPAD_LEGACY,
        platform: "iPad",
        maxTouchPoints: 5,
        screenMinSide: 820,
        isAndroid: false,
        isIos: true,
      }),
    ).toEqual({ isTablet: true, isPhone: false });
  });

  test("iPadOS spoofing desktop Safari (MacIntel + touch) is a tablet", () => {
    expect(
      detectFormFactor({
        userAgent: IPAD_DESKTOP_SPOOF,
        platform: "MacIntel",
        maxTouchPoints: 5,
        screenMinSide: 1024,
        isAndroid: false,
        isIos: true,
      }),
    ).toEqual({ isTablet: true, isPhone: false });
  });

  test("Android phone (Mobile UA token) is a phone", () => {
    expect(
      detectFormFactor({
        userAgent: ANDROID_PHONE,
        platform: "Linux armv8l",
        maxTouchPoints: 5,
        screenMinSide: 412,
        isAndroid: true,
        isIos: false,
      }),
    ).toEqual({ isTablet: false, isPhone: true });
  });

  test("Android tablet without the Mobile token is a tablet", () => {
    expect(
      detectFormFactor({
        userAgent: ANDROID_TABLET_NO_MOBILE,
        platform: "Linux aarch64",
        maxTouchPoints: 5,
        screenMinSide: 800,
        isAndroid: true,
        isIos: false,
      }),
    ).toEqual({ isTablet: true, isPhone: false });
  });

  test("Android tablet that keeps Mobile token but is wide (>=600dp) is a tablet", () => {
    expect(
      detectFormFactor({
        userAgent: ANDROID_PHONE.replace("Pixel 8", "Tab"),
        platform: "Linux aarch64",
        maxTouchPoints: 5,
        screenMinSide: 720,
        isAndroid: true,
        isIos: false,
      }),
    ).toEqual({ isTablet: true, isPhone: false });
  });

  test("desktop (a real Mac, no touch) is neither tablet nor phone", () => {
    expect(
      detectFormFactor({
        userAgent: IPAD_DESKTOP_SPOOF,
        platform: "MacIntel",
        maxTouchPoints: 0,
        screenMinSide: 1440,
        isAndroid: false,
        isIos: false,
      }),
    ).toEqual({ isTablet: false, isPhone: false });
  });
});
