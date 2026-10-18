// The build-time constants vite.config.ts defines, for tests that load app
// modules reading them at import (src/runtime/version.ts and the platform
// layer). Each is set only if absent, so a test file's own value wins.
function defineTestGlobal(name: string, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(globalThis, name)) return;
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

defineTestGlobal("__APP_VERSION__", "test");
defineTestGlobal("__BUILD_EXPIRY_DAYS__", 0);
defineTestGlobal("__BUILD_TIMESTAMP__", 0);
defineTestGlobal("__SHIORI_ANDROID_DISTRIBUTION__", undefined);
defineTestGlobal("__TAURI_ENV_FAMILY__", undefined);
defineTestGlobal("__TAURI_ENV_PLATFORM__", undefined);
defineTestGlobal("__TAURI_ENV_TARGET_TRIPLE__", undefined);
