import { T } from "../../../design/tokens";
import type { TextOverlay } from "../../../pdf/model/types";

export function fontFamilyCss(family: TextOverlay["fontFamily"]): string {
  if (family === "notoSansSc") {
    return "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";
  }
  if (family === "notoSansJp") {
    return "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif";
  }
  if (family === "serif") return T.bodySerif;
  if (family === "mono") return T.mono;
  return T.sans;
}

// contentText (original-text) edits must mirror the EXPORT fallback's
// metrics — PDF Standard-14 Times / Helvetica / Courier — not the app's
// UI faces (Inter, JetBrains Mono), whose widths differ and would make
// the on-screen edit disagree with the exported layout. Each stack ends
// in a bundled Liberation face with identical glyph widths, so the
// resolution is deterministic even where none of the system fonts exist
// (Android WebView, bare Linux).
export function contentFontFamilyCss(
  family: TextOverlay["fontFamily"],
): string {
  if (family === "serif") return T.bodySerif;
  if (family === "sans") {
    return "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', 'Nimbus Sans', sans-serif";
  }
  if (family === "mono") {
    return "'Courier New', Courier, 'Liberation Mono', 'Nimbus Mono PS', monospace";
  }
  return fontFamilyCss(family);
}
