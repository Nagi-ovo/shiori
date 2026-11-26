import { expect, test } from "bun:test";
import { fakePdfDocument } from "../../test/fakePdfEngine";
import type { PageModel, SourceImageEditOverlay } from "../../pdf/model/types";
import type { SourceImageInfo } from "../../pdf/export/sourceImages";
import { sanitizeHistory } from "../../storage/draftValidation";
import { createPdfEditorStore } from "./store";
import { commitSourceImageEdit, findSourceImageEdit, replaceSourceImage } from "./sourceImageEdits";

const page: PageModel = { id: "second", sourceIndex: 1, rotation: 90, widthPt: 200, heightPt: 160 };
const paint: SourceImageInfo = {
  pageIndex: 1, occurrence: 3, kind: "xobject", formPath: ["Outer", "Inner"], name: "Photo",
  fingerprint: "ab".repeat(32), bbox: { x: 10, y: 20, w: 30, h: 40 },
  matrix: [30, 0, 0, 40, 10, 20], widthPx: 12, heightPx: 17, masked: true, shared: true,
};

function setup() {
  const store = createPdfEditorStore();
  store.getState().setOpened({
    fileName: "images.pdf", fileSize: 1, bytes: Uint8Array.of(1),
    doc: fakePdfDocument(), sourcePages: [page],
  }, [page]);
  return { store, opened: store.getState().opened!, page: store.getState().model.pages[0]! };
}

// Selection must leave a clean baseline. Consecutive actions should keep one
// address, one history step each, and survive serialized history restoration.
test("image actions coalesce by paint and page across history and draft recovery", () => {
  const { store, opened, page } = setup();
  const baseline = store.getState().model;
  expect(findSourceImageEdit(baseline.overlays, page.id, paint)).toBeUndefined();
  expect(store.getState().undoStack).toEqual([]);
  const act = (patch: Partial<SourceImageEditOverlay>) => commitSourceImageEdit(
    store, opened, page, paint, findSourceImageEdit(store.getState().model.overlays, page.id, paint), patch,
  );
  expect(act({ rect: paint.bbox })).toBe(false);
  expect(act({ rect: { x: 22, y: 30, w: 30, h: 40 } })).toBe(true);
  const first = store.getState().model.overlays[0]!;
  expect(act({ angle: 90 })).toBe(true);
  expect(act({ crop: { x: .25, y: .25, w: .5, h: .5 } })).toBe(true);
  expect(act({ crop: undefined })).toBe(true);
  expect(act({ delete: true })).toBe(true);
  const { model, undoStack } = store.getState();
  expect(model.overlays).toEqual([{ ...first, angle: 90, delete: true }]);
  expect(undoStack).toHaveLength(5);
  expect(sanitizeHistory(JSON.parse(JSON.stringify(undoStack)))).toEqual(undoStack);
  for (let i = 0; i < 5; i++) store.getState().undo();
  expect(store.getState().model).toEqual(baseline);
  for (let i = 0; i < 5; i++) store.getState().redo();
  expect(store.getState().model).toEqual(model);
});

test("a pending image action rejects a changed occurrence, page, document or permission", () => {
  const { store, opened, page } = setup();
  const replace = { mimeType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" } as const;
  expect(commitSourceImageEdit(store, opened, page, paint, undefined, { angle: 45 })).toBe(true);
  expect(commitSourceImageEdit(store, opened, page, paint, undefined, { replace })).toBe(false);
  const edit = findSourceImageEdit(store.getState().model.overlays, page.id, paint);
  store.getState().setActivePage("other");
  expect(commitSourceImageEdit(store, opened, page, paint, edit, { replace })).toBe(false);
  store.getState().setActivePage(page.id);
  store.setState({ readerMode: true });
  expect(commitSourceImageEdit(store, opened, page, paint, edit, { replace })).toBe(false);
  store.setState({ readerMode: false, opened: { ...opened, encrypted: true } });
  expect(commitSourceImageEdit(store, store.getState().opened!, page, paint, edit, { replace })).toBe(false);
  expect(commitSourceImageEdit(store, opened, page, paint, edit, { replace })).toBe(false);
  expect(store.getState().undoStack).toHaveLength(1);
});

test("replacement completion respects cancellation and a later edit", async () => {
  const { store, opened, page } = setup();
  const payload = { mimeType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" } as const;
  const loader = Promise.withResolvers<typeof payload>();
  let selected = true;
  const cancelled = replaceSourceImage(store, opened, page, paint, undefined, loader.promise, () => selected);
  selected = false;
  loader.resolve(payload);
  expect(await cancelled).toBe(false);
  expect(store.getState().undoStack).toHaveLength(0);

  const later = Promise.withResolvers<typeof payload>();
  const replacing = replaceSourceImage(store, opened, page, paint, undefined, later.promise, () => true);
  expect(commitSourceImageEdit(store, opened, page, paint, undefined, { angle: 15 })).toBe(true);
  later.resolve(payload);
  expect(await replacing).toBe(false);
  expect(store.getState().undoStack).toHaveLength(1);
  const edit = findSourceImageEdit(store.getState().model.overlays, page.id, paint);
  expect(await replaceSourceImage(store, opened, page, paint, edit, Promise.resolve(payload), () => true)).toBe(true);
  expect(store.getState().model.overlays).toMatchObject([{ id: edit!.id, angle: 15, replace: payload }]);
  store.getState().undo();
  expect(store.getState().model.overlays).toEqual([edit!]);
});

test("retains an explicit same-bounds reset of a mirror through updates and undo", () => {
  const { store, opened, page } = setup();
  const mirror: SourceImageInfo = { ...paint, matrix: [-30, 0, 0, 40, 40, 20] };
  const current = () => findSourceImageEdit(store.getState().model.overlays, page.id, mirror);
  const act = (patch: Partial<SourceImageEditOverlay>) =>
    commitSourceImageEdit(store, opened, page, mirror, current(), patch);
  expect(act({ rect: mirror.bbox })).toBe(true);
  expect(current()?.rect).toEqual(mirror.bbox);
  expect(act({ rect: { ...mirror.bbox } })).toBe(false);
  expect(act({ angle: 45 })).toBe(true);
  expect(current()?.rect).toEqual(mirror.bbox);
  expect(act({ rect: undefined })).toBe(true);
  expect(current()?.rect).toBeUndefined();
  store.getState().undo();
  expect(current()?.rect).toEqual(mirror.bbox);
  store.getState().undo();
  store.getState().undo();
  expect(current()).toBeUndefined();
});
