// Strip C0/C1 controls (keeping only \n and \t) plus DEL at the human-mode
// print boundary. Document text, names, and snippets are untrusted: a hostile
// PDF can embed ESC/CSI/OSC sequences that retitle the terminal, write the
// clipboard via OSC 52, or stage paste-to-execute payloads. JSON mode is safe
// because JSON.stringify escapes control characters.
export function sanitizeTerminalText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
