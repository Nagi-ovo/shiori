export type RemoteImagePolicy = "ask" | "always" | "never";

export type DocumentImageSummary = {
  remoteImages: number;
  blockedRemoteImages: number;
  localImages: number;
  failedLocalImages: number;
};

export type LocalImageData = {
  dataUrl: string;
  mime: string;
  size: number;
};

export type ReadLocalImage = (
  documentPath: string,
  imageSrc: string,
) => Promise<LocalImageData | null>;

export type ImageResourceOptions = {
  allowRemoteImages: boolean;
  documentPath?: string;
  readLocalImage?: ReadLocalImage;
};

type RemoteUrlKind = "https" | "http" | "protocol-relative";

const EMPTY_SUMMARY: DocumentImageSummary = {
  remoteImages: 0,
  blockedRemoteImages: 0,
  localImages: 0,
  failedLocalImages: 0,
};

const REMOTE_RESOURCE_ATTRS = [
  { selector: "link[href]", attrs: ["href"], policy: "always-block" },
  { selector: "source[src]", attrs: ["src"], policy: "always-block" },
  { selector: "video[src], video[poster]", attrs: ["src", "poster"], policy: "always-block" },
  { selector: "audio[src]", attrs: ["src"], policy: "always-block" },
  { selector: "track[src]", attrs: ["src"], policy: "always-block" },
  // Legacy table/body background images, which DOMPurify keeps.
  { selector: "[background]", attrs: ["background"], policy: "image" },
  {
    selector: "image[href], image[xlink\\:href]",
    attrs: ["href", "xlink:href"],
    policy: "image",
  },
] as const;

const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^'";)\s]+))(?:\s*\))?[^;{]*;?/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/gi;
const MAX_LOCAL_IMAGES = 32;
const MAX_LOCAL_IMAGE_TOTAL_BYTES = 48 * 1024 * 1024;

export async function resolveDocumentImageResources(
  html: string,
  options: ImageResourceOptions,
): Promise<{ html: string; summary: DocumentImageSummary }> {
  const doc = parseHtmlDocument(html);
  if (!html || !doc) {
    return { html, summary: EMPTY_SUMMARY };
  }

  const isFullDocument = looksLikeFullHtmlDocument(html);
  const summary: DocumentImageSummary = { ...EMPTY_SUMMARY };
  const images = Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"));
  let localImageBytes = 0;

  for (const img of images) {
    const rawSrc = img.getAttribute("src")?.trim();
    if (!rawSrc) continue;

    const remoteKind = getRemoteUrlKind(rawSrc);
    if (remoteKind) {
      summary.remoteImages += 1;
      if (shouldBlockImageUrl(remoteKind, options.allowRemoteImages)) {
        blockImage(img, "remote");
        summary.blockedRemoteImages += 1;
      }
      continue;
    }

    if (!isLocalRelativeImageSrc(rawSrc)) continue;

    const imageSrc = decodeLocalImageSrc(rawSrc);
    if (!imageSrc || !options.documentPath || !options.readLocalImage) {
      blockImage(img, "local");
      summary.failedLocalImages += 1;
      continue;
    }

    try {
      const local = await options.readLocalImage(options.documentPath, imageSrc);
      if (!local?.dataUrl) {
        blockImage(img, "local");
        summary.failedLocalImages += 1;
        continue;
      }
      if (
        summary.localImages >= MAX_LOCAL_IMAGES ||
        localImageBytes + local.size > MAX_LOCAL_IMAGE_TOTAL_BYTES
      ) {
        blockImage(img, "local");
        summary.failedLocalImages += 1;
        continue;
      }
      img.setAttribute("src", local.dataUrl);
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      localImageBytes += local.size;
      summary.localImages += 1;
    } catch {
      blockImage(img, "local");
      summary.failedLocalImages += 1;
    }
  }

  scrubRemoteResourceAttributes(doc, options.allowRemoteImages, summary);
  scrubRemoteStyleUrls(doc, options.allowRemoteImages, summary);
  if (isFullDocument) injectStaticDocumentCsp(doc, options.allowRemoteImages);

  return {
    html: serializeDocument(doc, isFullDocument),
    summary,
  };
}

function parseHtmlDocument(html: string): Document | null {
  const Parser =
    typeof DOMParser === "undefined"
      ? typeof window === "undefined"
        ? null
        : window.DOMParser
      : DOMParser;
  if (!Parser) return null;
  return new Parser().parseFromString(html, "text/html");
}

function looksLikeFullHtmlDocument(html: string): boolean {
  return /^\s*(<!doctype\s+html\b|<html[\s>])/i.test(html);
}

function serializeDocument(doc: Document, isFullDocument: boolean): string {
  if (!isFullDocument) return doc.body.innerHTML;
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function staticDocumentCsp(allowRemoteImages: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${allowRemoteImages ? " https:" : ""}`,
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "navigate-to 'none'",
  ].join("; ");
}

function injectStaticDocumentCsp(doc: Document, allowRemoteImages: boolean) {
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", staticDocumentCsp(allowRemoteImages));
  doc.head.prepend(csp);
}

// Classified the way the browser will load it, not by prefix: the URL parser
// repairs "https:host/x" and "https:\host/x" to https://host/x, and reads
// "\\host/x" or "/\host/x" as another host. Relative references resolve
// against a fixed special-scheme base so every platform gets one answer
// (macOS documents resolve against tauri://, where "\" is not a slash).
const RELATIVE_URL_ORIGIN = "https://shiori-document.invalid";

function getRemoteUrlKind(src: string): RemoteUrlKind | null {
  const trimmed = src.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      const { protocol } = new URL(trimmed);
      return protocol === "https:" ? "https" : protocol === "http:" ? "http" : null;
    }
    const { origin } = new URL(trimmed, `${RELATIVE_URL_ORIGIN}/`);
    return origin === RELATIVE_URL_ORIGIN ? null : "protocol-relative";
  } catch {
    return null;
  }
}

function shouldBlockImageUrl(
  remoteKind: RemoteUrlKind,
  allowRemoteImages: boolean,
): boolean {
  return remoteKind !== "https" || !allowRemoteImages;
}

function isLocalRelativeImageSrc(src: string): boolean {
  if (!src || src.startsWith("#") || src.startsWith("?")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false;
  if (src.startsWith("//")) return false;
  if (src.startsWith("/") || src.startsWith("\\")) return false;
  return true;
}

function decodeLocalImageSrc(src: string): string | null {
  const withoutHash = src.split("#", 1)[0] ?? "";
  const withoutQuery = withoutHash.split("?", 1)[0]?.trim() ?? "";
  if (!withoutQuery) return null;
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery;
  }
}

function scrubRemoteResourceAttributes(
  doc: Document,
  allowRemoteImages: boolean,
  summary: DocumentImageSummary,
) {
  for (const { selector, attrs, policy } of REMOTE_RESOURCE_ATTRS) {
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      for (const attr of attrs) {
        const rawValue = element.getAttribute(attr)?.trim();
        if (!rawValue) continue;

        const remoteKind = getRemoteUrlKind(rawValue);
        if (!remoteKind) continue;

        const isImagePolicy = policy === "image";
        if (isImagePolicy) summary.remoteImages += 1;
        if (isImagePolicy && !shouldBlockImageUrl(remoteKind, allowRemoteImages)) {
          continue;
        }

        removeResourceAttribute(element, attr);
        if (isImagePolicy) summary.blockedRemoteImages += 1;
      }
    }
  }
}

function scrubRemoteStyleUrls(
  doc: Document,
  allowRemoteImages: boolean,
  summary: DocumentImageSummary,
) {
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>("[style]"))) {
    const rawStyle = element.getAttribute("style") ?? "";
    const safeStyle = sanitizeCssRemoteUrls(rawStyle, allowRemoteImages, summary);
    if (safeStyle === rawStyle) continue;
    if (safeStyle.trim()) {
      element.setAttribute("style", safeStyle);
    } else {
      element.removeAttribute("style");
    }
  }

  for (const style of Array.from(doc.querySelectorAll<HTMLStyleElement>("style"))) {
    const rawStyle = style.textContent ?? "";
    const safeStyle = sanitizeCssRemoteUrls(rawStyle, allowRemoteImages, summary);
    if (safeStyle !== rawStyle) style.textContent = safeStyle;
  }
}

function sanitizeCssRemoteUrls(
  css: string,
  allowRemoteImages: boolean,
  summary: DocumentImageSummary,
): string {
  return css
    .replace(CSS_IMPORT_RE, (match, doubleQuoted, singleQuoted, unquoted) => {
      const rawUrl = String(doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
      return getRemoteUrlKind(rawUrl) ? "" : match;
    })
    .replace(CSS_URL_RE, (match, doubleQuoted, singleQuoted, unquoted) => {
      const rawUrl = String(doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
      const remoteKind = getRemoteUrlKind(rawUrl);
      if (!remoteKind) return match;
      summary.remoteImages += 1;
      if (!shouldBlockImageUrl(remoteKind, allowRemoteImages)) return match;
      summary.blockedRemoteImages += 1;
      return "none";
    });
}

function removeResourceAttribute(element: Element, attr: string) {
  element.removeAttribute(attr);
  element.setAttribute(`data-shiori-blocked-remote-${dataAttrName(attr)}`, "true");
}

function dataAttrName(attr: string): string {
  return attr.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
}

function blockImage(img: HTMLImageElement, reason: "remote" | "local") {
  img.removeAttribute("src");
  img.setAttribute(`data-shiori-blocked-${reason}-src`, "true");
}
