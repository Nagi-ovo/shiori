// The source-text editor control: where its caret opens and whether it
// paints glyphs over a page frame that already shows them.
//
// Failure list: the caret opens at 0 regardless of the hit offset; a hit
// offset is applied to the wrong overlay or reapplied on a later edit of the
// same overlay, or held past the frame that opened it (draft overlays keep
// their ids across loads, so a stale request would surface in a later
// document); the control paints its text while the page frame still shows
// the same source glyphs (double print) — or hides the caret with them.
import '../../../test/setupDom';
import '../../../i18n';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';
import { createRef } from 'react';
import { TextOverlayEditor } from './TextOverlayEditor';
import { requestEditCaret } from './editCaret';
import { overlay } from '../../../pdf/export/contentText/fixtures.test-support';

afterEach(cleanup);
const mount = (id: string, glyphsHidden?: boolean) => {
  const ref = createRef<HTMLTextAreaElement>();
  const view = render(<TextOverlayEditor overlay={overlay({ id, text: 'ABCDE\nFGHIJ', color: '#336699' })} textareaRef={ref}
    onCommitEdit={() => {}} onMaybeSuppressEditDragBlur={() => false} glyphsHidden={glyphsHidden} />);
  return { view, field: ref.current! };
};

test('opens with the caret at the requested character boundary of that edit only', () => {
  requestEditCaret('hit', 8);
  const { field, view } = mount('hit');
  expect([field.selectionStart, field.selectionEnd]).toEqual([8, 8]);
  view.unmount();
  // consumed: re-entering the same edit later does not jump back to 8
  expect(mount('hit').field.selectionStart).not.toBe(8);
  cleanup();
  requestEditCaret('other', 3);
  expect(mount('mine').field.selectionStart).not.toBe(3);
});

test('a caret request not taken by the end of its frame never reaches a later mount', async () => {
  requestEditCaret('reused', 8);
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  expect(mount('reused').field.selectionStart).not.toBe(8);
});

test('keeps glyphs transparent but the caret visible while the page frame shows them', () => {
  const hidden = mount('a', true).field;
  expect(hidden.style.color).toBe('transparent');
  expect(hidden.style.caretColor).not.toBe('transparent');
  expect(hidden.style.caretColor).not.toBe('');
  cleanup();
  const shown = mount('b', false).field;
  expect(shown.style.color).toBe('inherit');
});
