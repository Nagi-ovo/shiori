// Tablet vs phone form-factor detection — a pure, unit-tested function.
//
// This is a RUNTIME decision: the same iOS/Android binary serves both form
// factors, and the build-time __TAURI_ENV_*__ signals only distinguish
// ios/android/desktop. The heuristics are brittle (iPadOS spoofs desktop
// Safari), which is exactly why this is an isolated, tested module. See
// docs/TABLET-BROWSER-HANDOFF.md §5.

export type FormFactorInput = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** Math.min(screen.width, screen.height) in CSS px — ~Android smallestWidth. */
  screenMinSide: number;
  isAndroid: boolean;
  isIos: boolean;
};

export function detectFormFactor(input: FormFactorInput): {
  isTablet: boolean;
  isPhone: boolean;
} {
  const { userAgent: ua, platform: plat, maxTouchPoints: touch } = input;
  // iPadOS reports either a literal "iPad" UA or spoofs desktop Safari
  // (platform "MacIntel" + touch). An iPhone never reports MacIntel.
  const isIPadOS = /iPad/i.test(ua) || (plat === "MacIntel" && touch > 1);
  // Android tablets drop the "Mobile" UA token phones carry; a >=600 CSS
  // shortest-side (~Android sw600dp) is the backstop for UAs that don't.
  const isAndroidTablet =
    input.isAndroid && (!/Mobile/i.test(ua) || input.screenMinSide >= 600);
  const isTablet = (input.isIos && isIPadOS) || isAndroidTablet;
  // Within a mobile context, anything that isn't a tablet is a phone.
  const isPhone = (input.isIos || input.isAndroid) && !isTablet;
  return { isTablet, isPhone };
}
