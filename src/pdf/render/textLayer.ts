import type {
  PdfPageTextContent,
  PdfTextItem,
  PdfTextMarkedContent,
} from "../engine/text";

/**
 * Shiori's text layer: invisible, selectable spans laid over the page raster,
 * one per text item, so the browser's own selection, copy and find work on a
 * PDF. Ported from pdf.js's TextLayer (Apache-2.0, see THIRD_PARTY_NOTICES.md)
 * so it no longer depends on pdf.js and takes any engine's page text
 * (docs/PLAN-RUST-PDF-CORE-2026-09.md, stage 4.3b). Two departures:
 *
 * - The page's rotation is folded into every span's position and angle. pdf.js
 *   lays spans out unrotated and leaves rotation to its viewer's stylesheet,
 *   which Shiori never had, so text on a turned page did not line up.
 * - Content arrives whole (the engine already bounded it), so rendering is
 *   synchronous; `render()` stays a promise for the callers written against
 *   pdf.js.
 *
 * Positions are percentages of the page and sizes use the
 * `--total-scale-factor` custom property (app.css .textLayer), so a zoom only
 * re-measures each span's horizontal scale (`update`).
 */

export type TextLayerViewport = {
  scale: number;
  /** Clockwise degrees: 0, 90, 180 or 270. */
  rotation: number;
  /** The page's view box in PDF user space, before rotation. */
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
};

type SpanProperties = {
  angle: number;
  canvasWidth: number;
  hasText: boolean;
  hasEOL: boolean;
  fontSize: number;
};

const MAX_TEXT_DIVS_TO_RENDER = 100_000;
const DEFAULT_FONT_SIZE = 30;

function multiply(m: readonly number[], n: readonly number[]): number[] {
  return [
    m[0]! * n[0]! + m[2]! * n[1]!,
    m[1]! * n[0]! + m[3]! * n[1]!,
    m[0]! * n[2]! + m[2]! * n[3]!,
    m[1]! * n[2]! + m[3]! * n[3]!,
    m[0]! * n[4]! + m[2]! * n[5]! + m[4]!,
    m[1]! * n[4]! + m[3]! * n[5]! + m[5]!,
  ];
}

/**
 * PDF user space to the rotated page at scale 1, y down: pdf.js's
 * PageViewport transform.
 */
export function pageDisplayTransform(viewport: TextLayerViewport): {
  transform: number[];
  width: number;
  height: number;
} {
  const { pageX: x0, pageY: y0, pageWidth: w, pageHeight: h } = viewport;
  const centerX = x0 + w / 2;
  const centerY = y0 + h / 2;
  const rotation = ((viewport.rotation % 360) + 360) % 360;
  const [a, b, c, d] =
    rotation === 90 ? [0, 1, 1, 0] : rotation === 180 ? [-1, 0, 0, 1] : rotation === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
  const turned = a === 0;
  const width = turned ? h : w;
  const height = turned ? w : h;
  const offsetX = width / 2;
  const offsetY = height / 2;
  return {
    transform: [a, b, c, d, offsetX - a * centerX - c * centerY, offsetY - b * centerX - d * centerY],
    width,
    height,
  };
}

function isTextItem(item: PdfTextItem | PdfTextMarkedContent): item is PdfTextItem {
  return (item as PdfTextItem).str !== undefined;
}

export class ShioriTextLayer {
  #container: HTMLElement;
  #root: HTMLElement;
  #content: PdfPageTextContent;
  #scale: number;
  #transform: number[];
  #pageWidth: number;
  #pageHeight: number;
  #textDivs: HTMLElement[] = [];
  #properties = new WeakMap<HTMLElement, SpanProperties>();
  #cancelled = false;

  static #ascentCache = new Map<string, number>();
  // One measuring canvas per language, attached to the document: the lang
  // decides which generic font WebKit falls back to, as it does for the spans.
  static #contexts = new Map<string, CanvasRenderingContext2D | null>();
  static #contextFonts = new WeakMap<CanvasRenderingContext2D, { size: number; family: string }>();
  static #minFontSize: number | null = null;

  constructor({
    content,
    container,
    viewport,
  }: {
    content: PdfPageTextContent;
    container: HTMLElement;
    viewport: TextLayerViewport;
  }) {
    this.#content = content;
    this.#container = this.#root = container;
    this.#scale = viewport.scale * (globalThis.devicePixelRatio || 1);
    const { transform, width, height } = pageDisplayTransform(viewport);
    this.#transform = transform;
    this.#pageWidth = width;
    this.#pageHeight = height;
    ShioriTextLayer.#ensureMinFontSize();
    container.style.setProperty("--min-font-size", String(ShioriTextLayer.#minFontSize));
  }

  get textDivs(): HTMLElement[] {
    return this.#textDivs;
  }

  render(): Promise<void> {
    if (this.#cancelled) return Promise.reject(new Error("Text layer rendering was cancelled"));
    const lang = this.#content.lang;
    if (lang) this.#root.lang = lang;
    for (const item of this.#content.items) {
      if (this.#textDivs.length > MAX_TEXT_DIVS_TO_RENDER) break;
      if (!isTextItem(item)) {
        if (item.type === "beginMarkedContentProps" || item.type === "beginMarkedContent") {
          const parent = this.#container;
          const span = document.createElement("span");
          span.classList.add("markedContent");
          if (item.id) span.setAttribute("id", `${item.id}`);
          if (item.tag === "Artifact") span.setAttribute("aria-hidden", "true");
          parent.append(span);
          this.#container = span;
        } else if (item.type === "endMarkedContent" && this.#container !== this.#root) {
          this.#container = this.#container.parentElement ?? this.#root;
        }
        continue;
      }
      this.#appendText(item);
    }
    return Promise.resolve();
  }

  /** A zoom: re-measure every span's horizontal scale at the new scale. */
  update({ viewport }: { viewport: Pick<TextLayerViewport, "scale"> }): void {
    const scale = viewport.scale * (globalThis.devicePixelRatio || 1);
    if (scale === this.#scale) return;
    this.#scale = scale;
    for (const div of this.#textDivs) {
      const properties = this.#properties.get(div);
      if (properties) this.#layout(div, properties);
    }
  }

  cancel(): void {
    this.#cancelled = true;
  }

  #appendText(item: PdfTextItem): void {
    const div = document.createElement("span");
    const properties: SpanProperties = {
      angle: 0,
      canvasWidth: 0,
      hasText: item.str !== "",
      hasEOL: item.hasEOL,
      fontSize: 0,
    };
    this.#textDivs.push(div);
    const tx = multiply(this.#transform, item.transform);
    let angle = Math.atan2(tx[1]!, tx[0]!);
    const style = this.#content.styles[item.fontName];
    if (style?.vertical) angle += Math.PI / 2;
    const fontFamily = style?.fontFamily ?? "sans-serif";
    const fontHeight = Math.hypot(tx[2]!, tx[3]!);
    const fontAscent = fontHeight * ShioriTextLayer.#ascent(fontFamily, style, this.#content.lang);
    let left: number;
    let top: number;
    if (angle === 0) {
      left = tx[4]!;
      top = tx[5]! - fontAscent;
    } else {
      left = tx[4]! + fontAscent * Math.sin(angle);
      top = tx[5]! - fontAscent * Math.cos(angle);
    }
    const divStyle = div.style;
    divStyle.left = `${((100 * left) / this.#pageWidth).toFixed(2)}%`;
    divStyle.top = `${((100 * top) / this.#pageHeight).toFixed(2)}%`;
    divStyle.setProperty("--font-height", `${fontHeight.toFixed(2)}px`);
    divStyle.fontFamily = fontFamily;
    properties.fontSize = fontHeight;
    div.setAttribute("role", "presentation");
    div.textContent = item.str;
    div.dir = item.dir;
    if (angle !== 0) properties.angle = angle * (180 / Math.PI);

    let shouldScaleText = false;
    if (item.str.length > 1) {
      shouldScaleText = true;
    } else if (item.str !== " " && item.transform[0] !== item.transform[3]) {
      const absScaleX = Math.abs(item.transform[0]!);
      const absScaleY = Math.abs(item.transform[3]!);
      if (
        absScaleX !== absScaleY &&
        Math.max(absScaleX, absScaleY) / Math.min(absScaleX, absScaleY) > 1.5
      ) {
        shouldScaleText = true;
      }
    }
    if (shouldScaleText) properties.canvasWidth = style?.vertical ? item.height : item.width;
    this.#properties.set(div, properties);
    this.#layout(div, properties);
    if (properties.hasText) this.#container.append(div);
    if (properties.hasEOL) {
      const br = document.createElement("br");
      br.setAttribute("role", "presentation");
      this.#container.append(br);
    }
  }

  #layout(div: HTMLElement, properties: SpanProperties): void {
    const { style } = div;
    if (properties.canvasWidth !== 0 && properties.hasText) {
      const context = ShioriTextLayer.#measuringContext(
        properties.fontSize * this.#scale,
        style.fontFamily,
        this.#content.lang,
      );
      const width = context?.measureText(div.textContent ?? "").width ?? 0;
      if (width > 0) {
        style.setProperty("--scale-x", String((properties.canvasWidth * this.#scale) / width));
      }
    }
    if (properties.angle !== 0) style.setProperty("--rotate", `${properties.angle}deg`);
  }

  static #measuringContext(
    size: number,
    family: string,
    lang: string | null,
  ): CanvasRenderingContext2D | null {
    const key = lang ?? "";
    let context = this.#contexts.get(key);
    if (context === undefined) {
      const canvas = document.createElement("canvas");
      canvas.className = "hiddenCanvasElement";
      canvas.lang = key;
      document.body.append(canvas);
      context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      this.#contexts.set(key, context);
      if (context) this.#contextFonts.set(context, { size: 0, family: "" });
    }
    const font = context ? this.#contextFonts.get(context) : undefined;
    if (context && font && (size !== font.size || family !== font.family)) {
      context.font = `${size}px ${family}`;
      font.size = size;
      font.family = family;
    }
    return context;
  }

  static #ensureMinFontSize(): void {
    if (this.#minFontSize !== null) return;
    const div = document.createElement("div");
    div.style.opacity = "0";
    div.style.lineHeight = "1";
    div.style.fontSize = "1px";
    div.style.position = "absolute";
    div.textContent = "X";
    document.body.append(div);
    this.#minFontSize = div.getBoundingClientRect().height || 1;
    div.remove();
  }

  /** The font's ascent as a share of its height, measured once per family. */
  static #ascent(
    fontFamily: string,
    style: { ascent?: number; descent?: number } | undefined,
    lang: string | null,
  ): number {
    const cached = this.#ascentCache.get(fontFamily);
    if (cached) return cached;
    const context = this.#measuringContext(DEFAULT_FONT_SIZE, fontFamily, lang);
    const metrics = context?.measureText("");
    const ascent = metrics?.fontBoundingBoxAscent;
    const descent = Math.abs(metrics?.fontBoundingBoxDescent ?? 0);
    let ratio = 0.8;
    if (ascent) {
      ratio = ascent / (ascent + descent);
    } else if (style?.ascent) {
      ratio = style.ascent;
    } else if (style?.descent) {
      ratio = 1 + style.descent;
    }
    this.#ascentCache.set(fontFamily, ratio);
    return ratio;
  }
}
