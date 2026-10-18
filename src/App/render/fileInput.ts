import type { ChangeEvent, CSSProperties } from "react";

export const FILE_INPUT_STYLE: CSSProperties = {
  position: "fixed",
  width: 1,
  height: 1,
  opacity: 0,
  left: 0,
  bottom: 0,
};

// These pickers are only ever opened programmatically, via .click() from a real
// button. `opacity: 0` hides them visually but leaves them focusable, so every
// render branch put an invisible "Choose File" in the tab order: a keyboard
// user tabbing the app hit a stop that announced "no file chosen" and opened
// an OS dialog. Kept in the layout (not display: none) because a detached
// input cannot be clicked in every browser — just taken out of the tab order
// and the accessibility tree.
export const FILE_INPUT_A11Y = { tabIndex: -1, "aria-hidden": true } as const;

/** The document picker's change handler, opening what was picked. */
export function openPickedFiles(open: (files: File[]) => Promise<void>) {
  return (e: ChangeEvent<HTMLInputElement>) => {
    // The input is `multiple`, so honour every selection. Picking three PDFs
    // used to open one and drop the rest silently.
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) void open(files);
  };
}
