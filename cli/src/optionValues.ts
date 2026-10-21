// Options and their values as parseArgs (main.ts) reads them out of argv;
// splitOption also serves the error-envelope scanner.
import { CliError } from "./cliError";

export function splitOption(arg: string): { name: string; inlineValue?: string } {
  if (!arg.startsWith("--")) return { name: arg };
  const equals = arg.indexOf("=");
  if (equals < 0) return { name: arg };
  return { name: arg.slice(0, equals), inlineValue: arg.slice(equals + 1) };
}

export function optionValue(
  argv: string[],
  currentIndex: number,
  name: string,
  inlineValue: string | undefined,
): { value: string; index: number } {
  if (inlineValue != null) {
    if (!inlineValue) throw new CliError("ERR_USAGE", `${name} requires a value`);
    return { value: inlineValue, index: currentIndex };
  }
  const value = argv[currentIndex + 1];
  if (value == null || value === "--" || value.startsWith("-")) {
    // A following "-3 dB" reads as a missing value, so only the inline form
    // can carry it; short options have none, and -o points at --output. The
    // value is never echoed: it may be a password.
    throw new CliError(
      "ERR_USAGE",
      `${name} requires a value`,
      value?.startsWith("-") && value !== "--"
        ? `A value beginning with '-' must be written inline: ${name === "-o" ? "--output" : name}=<value>`
        : undefined,
    );
  }
  return { value, index: currentIndex + 1 };
}

export function rejectInlineOptionValue(name: string, value: string | undefined): void {
  if (value != null) {
    throw new CliError("ERR_USAGE", `${name} does not accept a value`, value);
  }
}

export function positiveIntegerOption(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliError("ERR_USAGE", `${name} must be a positive integer`, raw);
  }
  return value;
}
