export const STAMP_DEFAULT_SIZE_PT = 14;
export const STAMP_MIN_SIZE_PT = 6;

// Size of a rectangle placed without a drag — that is, from the keyboard.
//
// Deliberately NOT wired into finishSmallCreationDrag: a *tap* with the
// rectangle tool yields nothing on purpose, so that a stray click cannot leave
// a stray box on the page. Keyboard placement is an explicit request, so it
// does need a size, and this is the single place that decides what it is.
export const RECT_KEYBOARD_WIDTH_PT = 144;
export const RECT_KEYBOARD_HEIGHT_PT = 96;
