// The version, defaults and limits that main.ts enforces and the help text quotes.
import packageJson from "../package.json" with { type: "json" };

export const CLI_VERSION = packageJson.version;
export const DEFAULT_AGENT_SEARCH_LIMIT = 20;
export const DEFAULT_SEARCH_LIMIT = 1_000;
export const MAX_SEARCH_LIMIT = 10_000;
export const MAX_EXTRACTED_TEXT_CHARACTERS = 10_000_000;
export const DEFAULT_RENDER_SCALE = 2;
