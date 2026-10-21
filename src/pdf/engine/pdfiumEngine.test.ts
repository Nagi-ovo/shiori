import "../../test/setupDom";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import type { PageModel } from "../model/types";
import { classifyPdfOpenError } from "../openPolicy";
import { createPdfiumEngine, pdfiumRenderStats, type PdfCoreBridge } from "./pdfiumEngine";

// The core bridge, as a fake handed to the factory: the engine's own job is
// what it asks the core, and what it makes of the answers.
const geometry = (count: number) =>
  Array.from({ length: count }, () => ({ rotation: 0, originX: 0, originY: 0, width: 300, height: 400 }));

// Every page reads "Hi" in Helvetica unless a test says otherwise.
const helloText = async () => ({
  glyphs: [..."Hi"].map((text, i) => ({
    text,
    origin: [72 + 6 * i, 700] as [number, number],
    end: [78 + 6 * i, 700] as [number, number],
    fontSize: 12,
    angle: 0,
    generated: false,
    fontName: "Helvetica",
    fontFlags: 32,
    ascent: 9,
    descent: -3,
  })),
  lang: "ja-JP" as string | null,
});

const core = {
  open: mock(async (): Promise<number> => 7),
  pageGeometry: mock(async () => geometry(5)),
  render: mock(
    (): Promise<Uint8ClampedArray<ArrayBuffer>> => Promise.resolve(new Uint8ClampedArray(4 * 2 * 2)),
  ),
  cancel: mock(() => undefined),
  close: mock(() => undefined),
  hide: mock(async () => 1),
  outline: mock(async () => [
    { title: "Core", destination: { pageIndex: 2, view: "Fit", args: [] }, children: [] },
  ]),
  links: mock(async () => [
    { rect: [1, 2, 3, 4] as [number, number, number, number], destination: null, url: "https://x/" },
  ]),
  decryptedCopy: mock(async () => new Uint8Array()),
  security: mock(
    async (): Promise<{ revision: number | null; permissions: number; userPermissions: number }> => ({
      revision: null,
      permissions: 0xffffffff,
      userPermissions: 0xffffffff,
    }),
  ),
  encryptLikeSource: mock(async (_doc: number, plain: Uint8Array) => Uint8Array.of(0xe0, ...plain)),
  pageFonts: mock(async () => new Uint8Array()),
  fontOutlines: mock((async () => new Uint8Array()) as (doc: number, page: number, names: string[]) => Promise<Uint8Array>),
  pageText: mock(helloText),
};
/** The arguments of one recorded call. */
const args = (fn: { mock: { calls: unknown[][] } }, call = 0) => fn.mock.calls[call] as unknown[];

// happy-dom has no ImageData; the engine only builds one to hand to the canvas.
globalThis.ImageData ??= class {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
} as unknown as typeof ImageData;

const engine = createPdfiumEngine(
  {
    open: core.open,
    pageGeometry: core.pageGeometry,
    render: core.render,
    cancel: core.cancel,
    close: core.close,
    hideAnnotations: core.hide,
    outline: core.outline,
    links: core.links,
    pageText: core.pageText,
    decryptedCopy: core.decryptedCopy,
    security: core.security,
    encryptLikeSource: core.encryptLikeSource,
    pageFonts: core.pageFonts,
    fontOutlines: core.fontOutlines,
  } as unknown as PdfCoreBridge,
);

function paintedCanvas() {
  const drawn: unknown[] = [];
  const canvas = Object.assign(document.createElement("canvas"), {
    getContext: () => ({ putImageData: (image: unknown) => drawn.push(image) }),
  }) as HTMLCanvasElement;
  return { canvas, drawn };
}

const request = {
  sourceIndex: 0,
  rotation: 0 as const,
  scale: 2,
  dpr: 2,
  region: { x: 512, y: 0, width: 2, height: 2 },
};

const pages: PageModel[] = Array.from({ length: 5 }, (_, i) => ({
  id: `p${i}`,
  sourceIndex: i,
  rotation: 0,
  widthPt: 300,
  heightPt: 400,
}));

/**
 * Five pages: a highlight and a web link on the first, a square on the
 * fourth, a NextPage link on the fifth.
 */
async function annotatedPdf(encrypt = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const ctx = pdf.context;
  const annots = [
    [{ Subtype: "Highlight", Rect: [1, 2, 30, 40], QuadPoints: [1, 40, 30, 40, 1, 2, 30, 2] },
      { Subtype: "Link", Rect: [5, 6, 7, 8], A: { S: "URI", URI: PDFString.of("https://x/") } }],
    [],
    [],
    [{ Subtype: "Square", Rect: [9, 9, 20, 20], C: [1, 0, 0], BS: { W: 1 } }],
    [{ Subtype: "Link", Rect: [0, 0, 9, 9], A: { S: "Named", N: "NextPage" } }],
  ];
  for (const list of annots) {
    const page = pdf.addPage([300, 400]);
    if (list.length === 0) continue;
    page.node.set(
      PDFName.of("Annots"),
      ctx.obj(list.map((entries) => ctx.register(ctx.obj({ Type: "Annot", ...entries } as never)))),
    );
  }
  if (encrypt) {
    ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({ Filter: "Standard", V: 2 }));
  }
  return pdf.save({ useObjectStreams: false });
}

beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockClear();
  core.open.mockImplementation(async () => 7);
});

describe("pdfiumEngine", () => {
  test("a document's pages come from the core", async () => {
    const bytes = new Uint8Array([1]);
    const { doc, bytes: kept } = await engine.load(bytes, { password: "pw" });
    expect(core.open).toHaveBeenCalledWith(bytes, "pw");
    expect(kept).toBe(bytes);
    expect(engine.pageCount(doc)).toBe(5);
    expect((await engine.pageGeometry(doc))[0]).toEqual({
      rotation: 0, originXPt: 0, originYPt: 0, widthPt: 300, heightPt: 400,
    });
  });

  test("a file the core will not open is reported for what it is", async () => {
    const failure = async (message: string) => {
      core.open.mockImplementationOnce(async () => {
        throw message;
      });
      return classifyPdfOpenError(await engine.load(new Uint8Array([1]), {}).catch((error: unknown) => error));
    };
    expect(await failure("PDF password required or incorrect")).toBe("password");
    expect(await failure("damaged PDF: PDFium error 3")).toBe("damaged");
    expect(await failure("PDFium library unavailable: no libpdfium")).toBe("engineUnavailable");
    expect(await failure("pdf-core-worker: out of memory")).toBe("engineUnavailable");
  });

  test("PDFium draws the region the page asks for, in device pixels", async () => {
    const { doc } = await engine.load(new Uint8Array([1]), {});
    const { canvas, drawn } = paintedCanvas();
    await engine.renderRegion(doc, request, canvas).done;
    const [docId, page, pixels, priority] = args(core.render);
    expect([docId, page, priority]).toEqual([7, 0, "visible"]);
    expect(pixels).toMatchObject({ pixelsPerPoint: 4, x: 512, y: 0, width: 2, height: 2 });
    expect(drawn).toHaveLength(1);
    expect([canvas.width, canvas.height, canvas.style.width]).toEqual([2, 2, "1px"]);
  });

  test("a region the core fails to draw fails, and counts", async () => {
    const { doc } = await engine.load(new Uint8Array([3]), {});
    const failedBefore = pdfiumRenderStats.failed;
    core.render.mockImplementationOnce(() => Promise.reject("render failed"));
    const { canvas, drawn } = paintedCanvas();
    await expect(engine.renderRegion(doc, request, canvas).done).rejects.toThrow("render failed");
    expect(drawn).toEqual([]);
    expect(pdfiumRenderStats.failed).toBe(failedBefore + 1);
  });

  test("a cancelled region is dropped by the core and never painted", async () => {
    const { doc } = await engine.load(new Uint8Array([4]), {});
    let finish: (rgba: Uint8ClampedArray<ArrayBuffer>) => void = () => {};
    core.render.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { canvas, drawn } = paintedCanvas();
    const handle = engine.renderRegion(doc, request, canvas);
    handle.cancel();
    const ticket = args(core.render)[4];
    expect(core.cancel).toHaveBeenCalledWith([ticket]);
    finish(new Uint8ClampedArray(16));
    await handle.done;
    expect(drawn).toEqual([]);
  });

  test("annotations Shiori takes over are read from the file and hidden from PDFium page by page", async () => {
    const bytes = await annotatedPdf();
    const { doc } = await engine.load(bytes, {});
    const overlays = await engine.importAnnotations(doc, pages, bytes);
    expect(overlays.map((overlay) => overlay.type)).toEqual(["highlight", "rect"]);
    const calls = core.hide.mock.calls.map((_, i) => args(core.hide, i).slice(0, 3));
    expect(calls).toEqual([
      [7, 0, [{ subtype: "Highlight", rect: [1, 2, 30, 40] }, { subtype: "Link", rect: [5, 6, 7, 8] }]],
      [7, 3, [{ subtype: "Square", rect: [9, 9, 20, 20] }]],
      // Links are Shiori's to draw, Named ones included.
      [7, 4, [{ subtype: "Link", rect: [0, 0, 9, 9] }]],
    ]);
  });

  test("an encrypted file's annotations are read from PDFium's decrypted copy", async () => {
    const clear = await annotatedPdf();
    core.decryptedCopy.mockImplementationOnce(async () => clear);
    const bytes = await annotatedPdf(true);
    const { doc } = await engine.load(bytes, {});
    const overlays = await engine.importAnnotations(doc, pages, bytes);
    expect(args(core.decryptedCopy)).toEqual([7]);
    expect(overlays.map((overlay) => overlay.type)).toEqual(["highlight", "rect"]);
  });

  test("links with Named actions, which PDFium drops, come from the import", async () => {
    const bytes = await annotatedPdf();
    const { doc } = await engine.load(bytes, {});
    await engine.importAnnotations(doc, pages, bytes);
    const links = await engine.pageLinks(doc, 4);
    expect(links.map((link) => link.url ?? link.action)).toEqual(["https://x/", "NextPage"]);
    expect((await engine.pageLinks(doc, 3)).map((link) => link.action)).toEqual([undefined]);
  });

  test("closing the document closes its PDFium copy", async () => {
    const { doc } = await engine.load(new Uint8Array([6]), {});
    await engine.destroy(doc);
    expect(core.close).toHaveBeenCalledWith(7);
  });

  test("an encrypted document reports its permissions unsigned, an unencrypted one none", async () => {
    const { doc: plain } = await engine.load(new Uint8Array([1]), {});
    expect(engine.security(plain)).toBeNull();

    // /P is a signed 32-bit integer in the file; the bindings may hand it over either way.
    core.security.mockImplementationOnce(async () => ({ revision: 6, permissions: -3900, userPermissions: -3904 }));
    const { doc: locked } = await engine.load(new Uint8Array([2]), { password: "user" });
    expect(engine.security(locked)).toEqual({
      revision: 6,
      permissions: -3900 >>> 0,
      userPermissions: -3904 >>> 0,
    });
  });

  test("a document whose security the core cannot report still opens, but never passes for unencrypted", async () => {
    core.security.mockImplementationOnce(async () => {
      throw "pdf-core-worker: security failed";
    });
    const { doc } = await engine.load(new Uint8Array([1]), {});
    expect(engine.pageCount(doc)).toBe(5);
    expect(() => engine.security(doc)).toThrow("security");
  });

  test("an encrypted source opens on its own copy, re-encrypts through it and closes once", async () => {
    core.open.mockImplementationOnce(async () => 11);
    core.security.mockImplementationOnce(async () => ({ revision: 4, permissions: -4, userPermissions: -44 }));
    const source = await engine.openEncryptedSource(new Uint8Array([3]), "owner");
    expect(args(core.open)).toEqual([new Uint8Array([3]), "owner"]);
    expect(source.security.revision).toBe(4);
    expect(Array.from(await source.encrypt(new Uint8Array([5])))).toEqual([0xe0, 5]);
    expect(args(core.encryptLikeSource)[0]).toBe(11);
    source.close();
    source.close();
    expect(core.close.mock.calls).toEqual([[11]]);
  });

  test("an unencrypted file is no encrypted source, and its copy is closed", async () => {
    core.open.mockImplementationOnce(async () => 12);
    await expect(engine.openEncryptedSource(new Uint8Array([4]), "")).rejects.toThrow(
      "re-encryption unsupported",
    );
    expect(core.close.mock.calls).toEqual([[12]]);
  });

  test("the outline and links come from PDFium", async () => {
    const { doc } = await engine.load(new Uint8Array([7]), {});
    expect((await engine.outline(doc))[0]?.title).toBe("Core");
    expect((await engine.pageLinks(doc, 4))[0]?.url).toBe("https://x/");
    expect(args(core.links)).toEqual([7, 4]);
  });

  test("a page's text is read by PDFium, in the document's language", async () => {
    const { doc } = await engine.load(new Uint8Array([7]), {});
    const text = await engine.pageText(doc, 2);
    expect(args(core.pageText)).toEqual([7, 2]);
    expect(text.content.items.map((item) => ("str" in item ? item.str : null))).toEqual(["Hi"]);
    expect(text.content.lang).toBe("ja-JP");
  });

  test("a page the core cannot read fails that read", async () => {
    core.pageText.mockImplementationOnce(async () => {
      throw "page-text-failed";
    });
    const { doc } = await engine.load(new Uint8Array([7]), {});
    await expect(engine.pageText(doc, 2)).rejects.toThrow("page-text-failed");
  });

  test("a thumbnail is the first page drawn by PDFium at twice its CSS width", async () => {
    const { doc } = await engine.load(new Uint8Array([7]), {});
    core.render.mockImplementationOnce(() => Promise.resolve(new Uint8ClampedArray(240 * 320 * 4)));
    const created: HTMLCanvasElement[] = [];
    const createElement = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      const element = createElement(tag);
      if (tag === "canvas") {
        Object.assign(element, {
          getContext: () => ({ putImageData: () => undefined }),
          toDataURL: () => "data:image/jpeg;base64,AA",
        });
        created.push(element as HTMLCanvasElement);
      }
      return element;
    }) as typeof document.createElement;
    try {
      expect(await engine.thumbnail(doc, 1, 120)).toBe("data:image/jpeg;base64,AA");
    } finally {
      document.createElement = createElement;
    }
    // 300 pt wide at 240 px: 0.8×, so 240 × 320 device pixels.
    expect(args(core.render)[2]).toMatchObject({ pixelsPerPoint: 0.8, width: 240, height: 320 });
    expect(args(core.render)[3]).toBe("thumbnail");
  });
});
