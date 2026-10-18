import { describe, expect, test } from "bun:test";
import type { NoteOverlay } from "../../pdf/model/types";
import { noteDisplayTimestamp, noteTimestamps } from "./noteMetadata";

describe("note metadata helpers", () => {
  test("initializes and reads note timestamps", () => {
    expect(noteTimestamps(1234)).toEqual({ createdAt: 1234, updatedAt: 1234 });

    const note: NoteOverlay = {
      type: "note",
      id: "n",
      pageId: "p",
      rect: { x: 0, y: 0, w: 100, h: 60 },
      text: "hello",
      color: "#f7e9a8",
      createdAt: 1000,
      updatedAt: 2000,
    };
    expect(noteDisplayTimestamp(note)).toBe(2000);
    expect(noteDisplayTimestamp({ ...note, updatedAt: undefined })).toBe(1000);
    expect(
      noteDisplayTimestamp({
        ...note,
        createdAt: undefined,
        updatedAt: undefined,
      }),
    ).toBeNull();
  });
});
