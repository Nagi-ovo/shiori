import { describe, expect, test } from "bun:test";
import {
  detectDocumentKind,
  DOCUMENT_INPUT_ACCEPT,
  DOCUMENT_PICKER_ACCEPT,
  documentKindShortLabel,
} from "./types";

describe("document intake metadata", () => {
  test("offers DOCX in both browser picker routes", () => {
    expect(detectDocumentKind("report.DOCX")).toBe("docx");
    expect(DOCUMENT_INPUT_ACCEPT).toContain(".docx");
    expect(
      DOCUMENT_PICKER_ACCEPT[
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ],
    ).toContain(".docx");
  });

  test("labels DOCX without falling back to another format", () => {
    expect(documentKindShortLabel("docx")).toBe("DOCX");
  });
});
