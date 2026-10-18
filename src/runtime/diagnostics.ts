import { PLATFORM_LABEL } from "../platform";
import { appVersion } from "./version";

export type DiagnosticContext = Record<
  string,
  string | number | boolean | null | undefined
>;

export type DiagnosticReportInput = {
  area: string;
  code: string;
  message: string;
  detail?: string | null;
  context?: DiagnosticContext;
};

export function diagnosticErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "unknown";
  if (typeof err === "string") return err || "unknown";
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(err ?? "unknown") || "unknown";
}

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const lines = [
    "Shiori diagnostic report",
    `time: ${new Date().toISOString()}`,
    `version: ${appVersion}`,
    `platform: ${PLATFORM_LABEL}`,
    `area: ${input.area}`,
    `code: ${input.code}`,
    `message: ${input.message}`,
  ];

  if (input.detail) lines.push(`detail: ${input.detail}`);

  const context = input.context ?? {};
  for (const [key, value] of Object.entries(context)) {
    if (value == null || value === "") continue;
    lines.push(`${key}: ${String(value)}`);
  }

  if (typeof navigator !== "undefined") {
    lines.push(`language: ${navigator.language}`);
    lines.push(`userAgent: ${navigator.userAgent}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function copyDiagnosticReport(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("clipboard-copy-failed");
}
