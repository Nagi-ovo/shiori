import "../../test/setupDom";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { PdfDocument, PdfSecurity } from "../../pdf/engine/types";
import { fakePdfDocument, withFakePdfEngine } from "../../test/fakePdfEngine";
import { useEncryptedPdfWarning } from "./useEncryptedPdfWarning";

// When the open-time notice can go wrong:
// - it nags about a file whose password allows every edit (encrypted or not);
// - it misses a file whose permissions refuse an edit;
// - it comes back every time the reader returns to the same tab;
// - it stays up for a tab that is no longer active;
// - the engine cannot report a document's security and the app breaks on
//   opening it (export refuses such a file; the notice just stays quiet).

afterEach(cleanup);

const security = (permissions: number): PdfSecurity => ({
  revision: 6,
  permissions,
  userPermissions: permissions,
});
const PLAIN = fakePdfDocument();
const OWNER = fakePdfDocument();
const NO_ANNOTATING = fakePdfDocument();
const UNKNOWN = fakePdfDocument();
const SECURITY = new Map<PdfDocument, PdfSecurity | null>([
  [PLAIN, null],
  [OWNER, security(0xfffffffc)],
  [NO_ANNOTATING, security(0xfffff0c0 | (1 << 3) | (1 << 10))],
]);
withFakePdfEngine({
  security: (doc) => {
    if (doc === UNKNOWN) throw new Error("PDFium could not report this document's security");
    return SECURITY.get(doc) ?? null;
  },
});

type Props = { hash: string | null; doc: PdfDocument | undefined };
const render = (initial: Props) =>
  renderHook(({ hash, doc }: Props) => useEncryptedPdfWarning(hash, doc), {
    initialProps: initial,
  });

describe("useEncryptedPdfWarning", () => {
  test("stays quiet for a document every edit is allowed on", () => {
    const view = render({ hash: "a", doc: OWNER });
    expect(view.result.current.encryptedPdfWarningHash).toBeNull();
    view.rerender({ hash: "b", doc: PLAIN });
    expect(view.result.current.encryptedPdfWarningHash).toBeNull();
  });

  test("warns once per restricted document, and only while it is active", () => {
    const view = render({ hash: "a", doc: NO_ANNOTATING });
    expect(view.result.current.encryptedPdfWarningHash).toBe("a");
    expect(view.result.current.restricted).toEqual(["annotations"]);

    view.rerender({ hash: "b", doc: OWNER });
    expect(view.result.current.encryptedPdfWarningHash).toBeNull();

    view.rerender({ hash: "a", doc: NO_ANNOTATING });
    expect(view.result.current.encryptedPdfWarningHash).toBeNull();
  });

  test("stays quiet when the engine cannot report a document's security", () => {
    const view = render({ hash: "a", doc: UNKNOWN });
    expect(view.result.current.encryptedPdfWarningHash).toBeNull();
    expect(view.result.current.restricted).toEqual([]);
  });
});
