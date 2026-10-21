# What's new

## [Unreleased]

### Export

- **Exporting some of the pages no longer carries the others along.** In some PDFs, exporting a single page used to leave content from other pages quietly inside the file.
- **Layers hidden by default stay hidden after export, and form calculations keep working.** A worksheet's answer layer no longer shows up in the export or in print, and right-to-left books keep their reading direction and two-page layout.
- **Rotated text boxes, stamps, rectangles, signatures and images keep their angle in the export.** The same goes for sidebar thumbnails and Small file exports.
- **Small file exports keep images and signatures, and the document's title and author.** Placed images and signatures now show in the sidebar thumbnails too.
- **Exporting an edit to the original text really removes the old text from the file.** In the rare cases where it can't, Shiori warns you before exporting: the old text is covered, but it can still be found and copied.

### Annotation import and export

- **Comments on annotations from Zotero, Preview and Acrobat are no longer wiped on export.** Comments on highlights, underlines, strikeouts, rectangles and ink all survive.
- **Hidden, locked and non-printing annotations stay that way after export.** Hidden annotations no longer become visible, and sticky notes keep their icon, open state and review state.
- **Text boxes and translucent marks from other apps look the way they did there.** Text boxes keep their fill, border and opacity on screen and in exports, and translucent ink, rectangles, underlines and strikeouts no longer turn opaque.
- **Annotation authors and replies come through export intact.** Chinese, Japanese and other non-Latin author names no longer turn into garbage, and replies stay attached to the annotation they answer.
- **Imported annotations land with the right page, colour and orientation.** In PDFs with an unusual page structure they no longer end up on another page, rectangle fills are no longer lost, the odd colour is no longer read wrong, and text notes on rotated pages no longer come in sideways.

### Editing

- **Annotations copied in one PDF can be pasted into another tab.** Duplicating an ink stroke with Cmd+D also offsets the copy instead of stacking it exactly on the original.
- **Undo history is cleaner.** Dragging in the colour picker counts as one step, Delete or the arrow keys on a locked annotation no longer leave an empty step, and your text selection no longer disappears after undo or redo.
- **You can click a paragraph on a two-column page and edit its original text.** Editing the original text of a merged PDF no longer picks the wrong font, either.
- **Arrows, Space and Enter go to the focused button, thumbnail rail or tab.** The arrow keys used to move the selected annotation instead.

### Find and text

- **Find matches phrases split by a line wrap.** Chinese and Japanese phrases across a wrap and words hyphenated across lines are found, and a match no longer runs into the next column or paragraph or stops halfway through an emoji, an accented letter, or a character in Hebrew, Arabic, Thai, Hindi and similar scripts.
- **Right-to-left text such as Hebrew and Arabic, and rotated text, can be searched and selected properly.** Stray spaces and line breaks used to appear inside words.

### Reading and pages

- **Moving the window to another screen redraws pages at that screen's sharpness.** Pages also stay sharp through continuous zooming and window resizing.
- **PDFs that record page sizes in an unusual way show pages at the right size.** Some A4 documents used to be treated as Letter.
- **More PDFs accept inserted pages and pasted images.** PDFs edited by other tools, or with an empty form, were often refused; inserted pages are also no longer mistaken by screen readers for paragraphs of the original document.

### Markdown and text files

- **If another editor changed the file, Cmd+S asks before overwriting it instead of doing so silently.**
- **Files that aren't UTF-8 open read-only, so saving can't garble them.** Saving also keeps the file's line endings and byte order mark, so fixing one typo in a file written on Windows no longer rewrites every line.
- **The Markdown preview is more dependable.** Documents that open with a "---" rule no longer lose their first section, in-page links and tables of contents scroll to their target, and local images with a % in the file name display.
- **Switching tabs tells you when a text edit could not be saved, instead of silently staying put.**

### Drafts and recovery

- **Cleanup no longer deletes documents you have open.** When storage runs low, annotation drafts of open tabs (in other windows too) are protected, and documents still opening, such as several PDFs dropped at once or one waiting for its password, are no longer lost.
- **Two copies of the same PDF in different places keep their own annotations.** Editing both used to lose one copy's annotations after a restart. Closing the page right after undoing back to the original also no longer brings an undone annotation back now and then.
- **The last few edits before you close a web tab are saved, and undo history is still there when you reopen.**

### Web

- **Chrome and Edge can open several files at once.** Downloading an export in Safari no longer fails now and then.

### Security

- **Tightened isolation for running HTML documents and for the Markdown preview.** This fixes several issues a malicious file could exploit, the "never load remote images" setting covers more cases, and on desktop the run approval only lists what it can actually allow.
- **Certain damaged or crafted PDFs and passwords no longer crash the app.** On web and mobile, a failed open no longer holds on to memory.

### Browser panel

- **Pages ask before handing off to another app, such as mail, phone, messages or maps.**
- **Back and the address bar are more accurate.** Back no longer greys out after you follow links back and forth, and frames inside a page no longer change the address bar or history. When a page goes back, forward or changes its address by itself, the buttons and address bar follow.
- **On the Mac, a page's dialogs now appear; on iPhone and iPad, links that open a new window and a page's dialogs work too.** On Android, a temporary session no longer mixes with your saved logins, and if the system WebView can't keep them apart, Shiori says so.

### Terminal

- **Pasting a large block of text into the built-in terminal no longer freezes the app.** Closing a terminal also ends the programs running in the background.
- **The built-in and external terminals open in the right folder when its name has spaces or special characters.** In the built-in Windows terminal with cmd, `start` with a web address opens in the Browser panel.

### Desktop

- **On Linux, opening a file or link in a system app no longer freezes Shiori.** Saving also handles its temporary file more safely, and files with very long names save normally.
- **The resource panel on macOS counts the web content processes, so memory and CPU figures are realistic.** The "About Shiori" menu item now follows the app language too.

### Android and iOS

- **Sharing a link or a piece of text to Shiori on Android opens it as a Markdown document.**
- **Direct updates on Android tell you when the install fails or is cancelled.** Once the system installer has the update you can close the update window, and coming back to Shiori from Recents no longer reopens an old file or shows a permission error.
- **Tightened what Shiori accepts and shares as files on Android and iOS.**

### Accessibility and interface

- **Screen readers can name more of the interface.** Rectangle, image, signature and original-text annotations are no longer read as English code words; the export range, address bar and text box editing fields have names; each draft's delete button names its file.
- **Focus in dialogs and Settings behaves better.** The page behind Settings is out of keyboard reach while it is open, focus returns to the button you used after a slow dialog closes, notifications stay clickable while a dialog is open, and the export quality warning is readable in dark themes.

### Command line

- **The CLI installs more reliably.** After a PowerShell install on Windows it handles PDFs from any folder, an interrupted npm install no longer leaves a half-installed version behind, and a piped install that fails partway now reports the failure instead of claiming success.
- **search and extract are more accurate and sturdier.** Search boxes land on the right characters, a large file with many annotations no longer stalls extract, and Word files are reported as unsupported straight away.
- **app annotate is more dependable.** Blank replies in the document or several replies to one annotation no longer make it fail, it finds the app again after a restart, the same annotations can be applied again with `--nonce`, and option values starting with "-" point you to the `--name=value` form.

## 26.10.20

> A Risky Racket

### Open source

- **Shiori and the Shiori CLI are open source! 🎉** As of today, every line of both is public at github.com/Nagi-ovo/shiori under the MIT license: read it, use it, change it, make it yours. After all this time building it, it is finally in everyone's hands. Ideas and bug reports are welcome on GitHub, and a star goes a long way.

### Encrypted PDFs

- **You can export edits to a password-protected PDF, and the export keeps its password.** Export used to ask you to remove the password with another tool first. Now the exported file opens with the same password as the original, and the original's limits on printing, editing and annotating still apply.
- **Password-protected PDFs can take inserted pages and be printed.** If the original doesn't allow printing, Shiori tells you so.

### Zoom and navigation

- **A trackpad pinch no longer gets stuck halfway.** Now and then the page stayed in its preview after you let go, until you zoomed again.
- **Pressing on a page no longer pulls it to the top.** Pressing on the sliver of the next page used to scroll the whole page up under the pointer.
- **Reopening a PDF lands at the top of the page you were on.** It could land hundreds of pixels off.
- **Keyboard and menu zoom step through the same levels as the toolbar.** From 150%, zooming out goes 125%, 110%, 100%.
- **Keys no longer reach the document behind an open dialog.** With the shortcut sheet open, Delete used to remove the selected annotation behind it.

### Interface

- **Dragging a tab to reorder it moves the whole tab.** Its title used to stretch and fade, and the tab could leave the tab strip.

## 26.9.27

> Stranger Searching

### Interface

- **The Windows window looks cleaner.** A simpler top edge, with buttons that follow the light and dark themes.
- **Neater scrollbars on Windows and Linux.**

### Fixed

- **You can move the window while a dialog is open.**
- **Notifications can be closed.**
- **Clearer message when a file has been moved or deleted.**

## 26.9.26

> Artistic Anarchy

### Performance

- **PDFs stay sharp at 8× zoom, and zooming is faster and lighter.**
  Past about 4× you used to see a stretched image with soft text; now what is
  on screen is drawn at the real zoom. Sidebar thumbnails no longer slow down
  the page you are reading. Measured on an Apple M5 Pro with an 8-page PDF:

| | 26.9.9 | This version |
|---|---:|---:|
| Sharpness at 8× zoom | about 4× | 8× |
| Sharp again after zooming to 4× | 87–121 ms | 66–68 ms |
| Memory at high zoom | 252–259 MB | 106 MB |

### Reading on mobile

- **Phones get an Annotate switch.** While you read, the tools fold away and
  the document gets the space; tap Annotate to bring them back, and Select
  returns when you are done.

### Interface

- **The selected tab now joins the toolbar beneath it.** It used to sit on
  the toolbar like a patch; now they are one surface, with the tab's corners
  curving into the tab bar.

### Fixed

- **Code blocks show properly while editing Markdown, with syntax
  highlighting.** They used to appear as raw fences; now they look as they do
  when reading, highlighted in both modes.
- **Switching a Markdown file to editing no longer stalls the first time.**
- **Switching between reading and editing Markdown keeps your place.** It
  used to jump to another section.
- **Selecting text works on rotated PDF pages.**
- **“Next page” and “Previous page” links in a PDF work**, as slides exported
  to PDF often use them.
- **Zoom In in the desktop menu reaches 800%.**
- **The “Editing will overwrite the set-aside draft” prompt can be
  dismissed**; the draft is kept and you are asked again on your next edit.
- **Closing a tab no longer flashes the home screen.**
- **With many PDFs open, going back to an earlier one no longer marks it
  Not exported.**
- **Chinese text in Word documents made from an English template stays
  inside the page.**
- **Imported annotations no longer show twice on desktop.**
- **Hidden annotations no longer turn up twice in an export.**
- **Copying from a page with a diagonal watermark no longer splits words.**

### Settings

- **The GPU acceleration switch is gone**; pages are drawn in a way it no
  longer affects.

## 26.9.9

> Hellhounds for Hire

### Reading on mobile

- **The phone hands a good deal more of the screen to the document.** The
  permanent bottom bar is gone — the page number floats in while you scroll and
  fades once you stop; a single open document no longer shows the tab strip,
  just its name; and a tool's properties float over the page instead of holding
  a row open. The document goes from 62% of the screen to 75%.
- **Changing tools still leaves the page exactly where it is — without an
  empty row held open for it.** That stillness used to cost a permanent row
  that said nothing. The properties panel has left the layout, so the row is
  no longer needed.
- **A restored draft is a notice now.** It no longer sits at the bottom
  permanently; it appears with "Open the original file" and goes away once you
  have dealt with it.

### Fixed

- **A PDF no longer goes blank as you scroll on Android.** Scrolling after a
  pinch zoom keeps showing the pages.

## 26.9.8

> Redeye Reprisal

### Reading on mobile

- **Word documents on Android no longer grow as you scroll.** A one-finger
  scroll could be mistaken for a two-finger pinch; PDF and Markdown pinch
  zoom got the same hardening.
- **The bottom of the UI sits on the screen edge again on Android.** No more
  off-colour band under the status and navigation bars, and the system bar
  icons follow Shiori's theme.
- **Turning PDF pages on a phone feels right.** One-finger scrolling keeps its
  momentum and no longer jumps at the start; the page stays put under a
  pinch; double-tap toggles between fit-width and zoomed in; the next page is
  prepared ahead of time.

### Documents

- **Word documents open faster.** Only the fonts a document actually uses are
  loaded; an English-only file no longer downloads the CJK faces first.
- **Chinese and Japanese Word documents no longer run past the page edge.**
  Paragraphs that name an East Asian font (Microsoft YaHei, DengXian, SimSun
  and others) now lay out in that font, so lines are no longer clipped; a
  second picture across a page boundary also shows up.

### Interface and performance

- **A PDF is sharp and selectable the moment you release a zoom.** The commit
  no longer waits through a blurry pause, and text and links are no longer
  rebuilt every time.
- **Taps on Android no longer flash the default highlight.**

## 26.9.7

> Tempestuous Temperaments

### Interface and performance

- **Secondary text is easier to read in every theme.** Status bar, hints, and
  file details reach standard contrast in all four presets; the Everforest
  themes bring secondary text closer to body text.
- **Number fields are easier to hit and accept typed values.** The stepper
  buttons are larger and always visible, opacity and font size can be typed
  directly, and ↑/↓ nudges a selected value.
- **The file name can be copied from the keyboard.** The title-bar file name
  is now a button: click or press Enter to copy, and hover to see the full
  name.
- **Releasing a pinch zoom no longer flashes the page.** Pages stay in place
  and take the new size where they are; highlights and text remain visible and
  the view does not jump.
- **Switching tools on a phone no longer shifts the page.** Select mode keeps
  the tool properties row, so the reading position stays put when you change
  tools or tap an annotation.
- **Editing stays smooth with thousands of annotations, and an idle window
  does less work.** Export status for very large documents is computed in idle
  time, the status bar only updates when something on it changes, and the
  changelog, update notice, and settings load the first time they open.
- **The changelog is easier to read.** Each release now has a clear version
  row with a codename beside it, and Chinese and Japanese entries no longer
  break with a stray space in the middle of a sentence.

## 26.8.12

### Pages and PDFs

- **Insert every page from another PDF after the page you are reading.** The
  source file stays unchanged, and Shiori carries over page annotations and
  working links between the inserted pages. Encrypted source PDFs, signed
  current PDFs, and files that cannot be copied safely are left untouched with
  a clear explanation.
- **PDF attachments now survive an edited full-document export.** Files that
  belong only to a deleted page are removed with that page. Selected-page
  exports continue to omit attachments for privacy; image-based Compact output
  keeps PDF-level attachments, but not files attached only to a page.

### Mobile reading

- **Wide Word pages now fit the screen.** Landscape pages, unusually large
  paper sizes, and wide tables stay inside the white page instead of spilling
  across the phone viewport. Common Chinese and Japanese sans-serif fonts also
  wrap using the same measurements Shiori uses to paint them.
- **Tabs scroll naturally on phones and tablets.** Swipe sideways to reach any
  open document, long-press before dragging to reorder, and use the fixed “+”
  without chasing it off screen.

### Interface and performance

- **Page menus and the home screen adapt to the space available.** Actions use
  one clear Lucide icon language, pointer highlights no longer stick, keyboard
  focus returns correctly, and language, theme, version, and quote controls no
  longer cover recent documents in short or narrow windows.
- **Opening and exporting large PDFs uses less memory.** Export tools load only
  when requested, previews calculate one chosen quality at a time, completed
  page canvases are released immediately, and failed PDF loads clean up their
  workers and buffers.
- **Security and runtime dependencies were refreshed.** PDF JavaScript remains
  disabled, Tauri moved to its fixed 2.11 line without regressing macOS cold
  opens, and fixable frontend and Rust advisories were cleared.

## 26.8.9

### Workspace

- **Documents, pages, marks, and mounted folders now share one navigator.** The
  reading area gets more room, while files from a workspace stay close without
  opening them one by one.
- **The tab bar now stays responsive with dozens of documents open.** Shiori
  keeps a small working set ready, rests inactive documents without losing
  edits or undo history, and restores the same reading position when you return.
- **Hidden documents are easier to manage.** The themed “+N” menu stays open
  while you close several tabs, can close all hidden tabs at once, and previews
  the last page before you switch. The navigator offers the same quick preview.

### Reading and editing

- **Word documents now open directly in Shiori.** They join Recents and the
  workspace, remember zoom and scroll position, and use the same reader on
  desktop, web, and mobile.
- **Zoom is smoother across PDF, Word, Markdown, and HTML.** The page stays under
  your fingers or pointer, and the reader no longer flashes blank or rebuilds
  the whole document on every step of a gesture.
- **The interface now keeps one clear shape across document types.** Navigation
  and tools stay in place, unavailable actions remain visible but disabled, and
  the refreshed icons, scrollbars, focus states, and drag controls feel like one
  workspace.

### Fixed

- **Removing pages no longer leaves broken navigation behind.** Outline entries
  explain when their destination is gone, and exported PDFs no longer carry
  dead outlines, opening actions, or page links.
- **Adding image pages and reopening work are safer.** Links and filled forms
  remain intact, consecutive pastes cannot cancel each other or land in another
  document, and exported or recovered documents keep the state you left them in.
- **Opening several documents is now resilient.** One unreadable selection no
  longer cancels the rest, and files that finish loading after you switch tabs
  stay open in the background without taking the screen back.

## 26.7.27

### Added
- **A Shiori command line that annotates the PDF already open in Shiori.** Scripts and AI assistants can highlight, underline and add notes to the document you are reading — no export and re-import — and the writing appears on screen as it happens.
- **Annotations can be placed by quoting the text instead of computing coordinates.** Write the sentence you want marked and Shiori finds it and works out the geometry. If it matches nothing, or several places, you get the candidate pages instead of a guess. Chinese and Japanese work the same way.
- **Scanned pages and figures can be rendered to an image.** For pages with no text layer, the command line turns one into a PNG so tools that can only read text can still see the page.
- **Annotations written from the command line are drawn at a human pace.** They appear stroke by stroke in batches rather than all at once, and each batch undoes on its own.
- **Open the current folder in your own terminal app.** Shiori remembers the terminal you picked last time and uses its real icon.
- **Markdown edits can be saved back to the original file.** Editing only ever wrote to Shiori's local working copy, leaving the file on disk untouched with nothing on screen saying so. ⌘S — or the Save button that appears while there are unsaved edits — now writes back to where the file came from.
- **Reading appearance controls for Markdown.** Body font, code font, heading colour, size, line height and content width are all yours to set.
- **Custom accent and paper colours, plus an Everforest paper tone.** Both are clamped to stay legible.
- **Windows and Linux get a native menu bar.** Only macOS had one; everywhere else every shortcut lived in the web layer.
- **The window remembers its size and position across launches.** No more snapping back to the default every time.
- **Callouts can be collapsed.** A collapsed callout becomes a small disc in its own colour carrying the first character of its text; click it to expand. Collapsing is only how it looks while you read — an exported PDF always contains the full callout.
- **Click anywhere on the page to write a callout.** Not just selected text — figures, formulas and scanned pages have no text layer, and now the callout points wherever you clicked.

### Improved
- **The toolbar is regrouped.** Rectangle joins the pen under Draw, signature and stamp join under Sign, the sticky-note tool has retired, and the callout tool is now plainly called Comment.
- **Selecting text shows it in the colour the tool is about to apply.** No need to let go to find out what the highlight will look like.
- **Comment boxes no longer sit on top of body text.** A new comment reads the whole page's text layout and lands in white space, preferring the margin beside the line it annotates.
- **Comment boxes narrow to fit a page margin and grow to fit their text.** They slip into the margin without covering a word, and a long remark is no longer silently clipped.
- **Selection handles are quieter round dots.**
- **The signature pad has a signing line, and Clear / Save moved somewhere handier.** A faint rule on the empty pad says "sign here" and disappears with your first stroke.
- **Collapsed sticky notes are steadier.** They can be dragged without accidentally expanding, they stay collapsed across page rotation and reopening, and the control works from the keyboard and a screen reader.
- **The interface itself no longer gets caught in selections.** The thumbnail rail stays out of PDF text selections, the reading area no longer raises the browser context menu, and keyboard focus has one consistent ring.
- **The built-in terminal no longer limits how small the window can get.** It steps aside instead.
- **Security hardening.** App commands are only callable from the trusted page, and vulnerable document-parsing dependencies were upgraded.

### Fixed
- **Annotations sat 180° off on pages rotated 90° or 270°.** Pages that carry rotation in the file — scans, landscape pages — were wrong the moment they opened, and anything drawn after rotating in-app looked right on screen but exported upside down.
- **Export could silently drop parts of the source PDF.** With an encrypted source in particular, the export looked successful and had the right page count while the file on disk was already broken.
- **Annotations Shiori cannot edit no longer vanish from the screen.** Arrows, ellipses, polygons, stamps, attachments and form fields drawn elsewhere were invisible while still sitting in the file; they now render.
- **Annotations survive an import/export round trip unchanged.** Text annotation styles and controls are no longer lost.
- **Draft autosave no longer loses work at one particular crash moment.** It no longer treats the only surviving recovery record as stale data to clean up.
- **Tab state stays truthful across navigation and restart.**
- **Gestures and keys no longer commit edits you did not make.**
- **Picking several files in the desktop dialog opens all of them**, not just the first.
- **The macOS menu bar follows your language.** Saving a PDF on the desktop is now an atomic write, so an interruption cannot leave half a file.
- **A batch of interface strings that still reached users in English are now translated.**
- **Resizing a comment box by its corner now tracks the pointer.** The card used to ease along behind the cursor while its leader line kept up exactly.
- **The signature dialog's buttons line up, and the website's navigation, printing and accessibility gaps are fixed.**

## 0.1.25 · 2026-07-07

### New
- **Whole-paragraph text editing.** With the text tool, click a paragraph and the whole block becomes an edit box (original line spacing and line starts preserved) — edit it directly, PDF Expert style. Figures and math paragraphs are skipped automatically with a short note, and drag-selecting a smaller range still works.
- **Undo history survives across sessions.** Drafts now save the last 50 edit steps too, so you can close the app, reopen the same PDF, and still step back through your earlier edits.

### Improved
- **Font fidelity when editing original text.** The edit box renders in the PDF's own embedded font — identical while editing, after committing, and on export; exports reuse the source font where possible and fall back to bundled fonts that are width-matched to Times/Helvetica/Courier, so layout width never shifts.
- **Warnings while editing original text.** If the replacement is wider than the original region or contains characters the source font lacks, a note appears live under the edit box instead of surprising you at export time.
- **Toolbar icons share one visual spec.** Unified stroke weight, corner language, and optical size, so the row reads calm and even.
- **Dense handwriting no longer blots out thumbnails.** Inflated hairline strokes turn proportionally translucent, so a heavily annotated page stays readable in the sidebar.
- **Lighter pen strokes.** Strokes are simplified before saving — smaller files, faster writing and exporting, no visible difference.
- **Reader mode now goes truly fullscreen (Android / iOS / iPad).** The system status bar (battery, Wi-Fi) and the home indicator hide together and return when you leave.

### Fixed
- **Edited original text is now truly removed.** Previously it was only covered — search, copy, and screen readers still found the old text in exported PDFs. Exports now contain only the replacement, and fully cleaned spots leave no white patch.
- **Extensive polish to original-text alignment, fonts, spacing, and selection.** Baseline alignment, multi-line spacing, mid-word selections, descender clipping, cross-line indents, and absorbing earlier edits were all refined this release.
- **Original-text edit boxes are fully pinned.** They can't be moved by dragging, arrow keys, or copy-paste — which previously aimed the cover at the wrong text and corrupted the export.
- **Compact-quality export and printing no longer lose characters silently.** Un-encodable characters warn the same way other quality modes do, and a failed print preparation now reports an error.
- **Dropping an unsupported file type now says so.**
- **macOS: cold-starting by double-clicking a PDF no longer occasionally loses the file.**
- **Phone/tablet: oversized files are rejected before reading, the export cache cleans itself, dismissing the share sheet no longer counts as exported, and recents errors match the PDF path.**
- **Pen: finishing a stroke lets you keep writing, without accidentally selecting existing strokes and annotations.**

## 0.1.24 · 2026-06-22

### New
- **Reusable signatures.** Draw a signature once, save it locally, import PNG/JPEG signatures, then click or drag to place them on a PDF. They export with the document like other annotations.
- **Everforest theme.** A new calm green theme joins Paper, Night, and Auto.
- **Terminal theme setting.** The embedded terminal can follow the app theme or stay pinned to Paper, Night, or Everforest without restarting the shell.

### Improved
- **Restored web tabs ask for permission again instead of giving up.** If a browser file handle loses access, Shiori now offers to re-authorize the same tab and shows a clearer recovery screen.
- **More honest resource metrics.** Tiny CPU usage now shows as `<0.1%` instead of rounding to `0.0%`, and desktop process sampling is warmer between refreshes.
- **Cleaner English homepage typography.** The public site is quieter and English-only outside the 栞 mark.

### Fixed
- **Long tab and title text is less likely to clip** in narrow windows.
- **Export/share bridge failures report clearer errors** when the native layer returns malformed data.

## 0.1.23 · 2026-06-16

### Improved
- **Smoother scrolling and annotation dragging.** Fewer unnecessary redraws when paging through a document or dragging annotations.
- **Collapse the annotation toolbar on desktop too.** Previously phone / tablet only; the desktop tool row now has a collapse caret to free up reading space, with the tabs and top bar kept in place.
- **Fit-width / fit-page are now one-tap actions.** They no longer stay "stuck" highlighted — each tap re-applies the fit, and the view still re-fits when you resize the window.
- **The resource panel shows real usage.** CPU / memory are labeled honestly by source, with storage usage and quota added; mobile now samples process metrics natively.
- **GPU acceleration is gated by a device capability probe.** Cards that can't accelerate fall back to software rendering automatically, so pages no longer render blank (still off by default).
- **Cleaner update notes.** Rendered like the changelog instead of one boxed block of text.
- **Full-width segmented controls in mobile Settings.**

### Fixed
- **Web: dropping a file onto an open document no longer loses your session.** It used to navigate the browser to that file and tear down the current tab along with any unsaved edits; now it just opens it.
- **macOS: ⌘C / ⌘A now copy / select annotations.** They were being swallowed by the system Edit menu and didn't work from the keyboard.
- **iOS: exporting a PDF now brings up the system share sheet.** It used to silently fail while reporting "shared," so the file never actually reached you.
- **The Export button is no longer pushed off-screen on small phones.**
- **The Windows embedded browser no longer freezes after opening a page.**
- **Chinese / Japanese / Korean text in mobile Settings no longer collapses to one character per line.**

## 0.1.22 · 2026-06-15

### Improved
- **Collapse the annotation toolbar on its own (phone / tablet).** A caret at the end of the tool row folds just the Select / Markup / Ink toolbar away for more reading room, keeping the tabs and top bar — distinct from reader mode, which hides all chrome.
- **Tablet layout polish.** On tablets the filename sits inline and the tool buttons stay compact, instead of a stretched phone layout.

### Fixed
- **Searching Chinese / Japanese / Korean text in documents.** CJK queries previously matched nothing (only digits and Latin worked); now fixed.
- **Android in-app updates.** The direct-install Android in-app update could fail; now fixed.

## 0.1.21 · 2026-06-14

### New
- **Embedded browser on tablets (iOS / Android).** Open a PDF on a tablet and a browser appears in the right rail, so you can browse the web alongside your document. It is enabled automatically by screen size and stays hidden on phones.

### Fixed
- **The embedded browser no longer freezes / crashes on Windows.** The browser panel re-rendered on every scroll frame, which froze WebView2 and spiked video memory; it now refreshes only when the panel becomes visible, and the embedded browser is re-enabled on Windows.
- **Quitting no longer leaves background processes behind.** Closing Shiori now fully terminates the embedded terminal and all of its child processes — no stray shells or leftover black window in Task Manager.
- **Lower memory after merging PDFs.** Appending/merging now releases the previous document promptly, avoiding worker and page-cache buildup.

### Improved
- **Memory tuning on compact windows / mobile.** PDF render-ahead is reduced to lower video and main memory, so scrolling long documents is less likely to be reclaimed under pressure.

## 0.1.20 · 2026-06-13

### Fixed
- **Android direct updates download the right version.** When the app offers a new version, the download no longer falls back to an older APK.
- **Android release packages are more reliable.** Direct APK and Google Play builds now generate the right install permissions for each channel.
- **Reopening a PDF returns to the last page you read** instead of defaulting back to page one.

### Improved
- **Refined the website hero.** The copy better matches Shiori's broader document workflow, and the demo/download area is more stable.

## 0.1.19 · 2026-06-11

### New
- **HTML run mode can load the remote dependencies you approve.** Pages that pull scripts, styles, or images from a CDN (three.js and friends) used to fail silently. A banner now lists everything the sandbox blocked and lets you allow sources one by one, then re-run.
- **Fit-page zoom.** Alongside fit-width, a new fit-page mode bounds the page to the viewport height, so slides and landscape scans no longer blow up too large.
- **Double-click to open PDFs on Windows and Linux.** Double-clicking a `.pdf` or "Open with Shiori" now opens it in the running window instead of a blank one.
- **Export and share PDFs on mobile.** iOS and Android now do a real export to the system share sheet, and opening files routes through the same native pipeline as desktop.
- **Support Shiori.** A quiet heart link in Settings → About opens sponsor options (WeChat / Alipay QR, GitHub Sponsors, Buy Me a Coffee, Afdian).
- **Android direct-install updates.** Direct-APK builds can download and install the latest APK in-app; Play builds still update through the store.
- **Markdown and HTML documents appear in Home recents.** Files you've opened now show up in the Home "Recent" list like PDFs, with a page preview — HTML renders as a scaled page preview instead of source text, and open text tabs are backfilled into recents when you return Home.

### Improved
- **Terminal and browser entries on the text-document top bar.** Text documents (Markdown / HTML) gained terminal and browser buttons, matching the PDF top bar.
- **⌘S opens Export.** A local-first editor has no separate save step, so ⌘S now opens the export dialog; closing a PDF tab with un-exported edits shows a gentle reminder.
- **macOS ⌘Z reaches document undo** instead of being swallowed by the WebView's text undo.
- **Exported files open in a new tab** rather than launching a second Shiori instance.
- **Smaller, faster exports.** Documents that share fonts and resources export far smaller and quicker — a 59-page sample went from 39.7 MB to 2.5 MB, about 4× faster.
- **CJK filenames export correctly** again.
- **Settings → About redesign** with a compact brand card, click-to-copy live version, and an update check.
- **Localized menus and keycaps.** The macOS app menu follows your language, and ⌘⇧⌥ shortcuts show as Ctrl/Shift/Alt on Windows and Linux.
- **Cleaner top bar.** Dropped the redundant LOCAL badge; text documents now share the PDF top-bar layout.
- **Export remembers your last mode and quality.**
- **Reduced-motion support.** Animations are near-instant when the system asks for reduced motion.
- **Touch polish.** Bigger resize and rotate hit areas, tap to edit text and notes, long-press to highlight, and a reading-mode toggle in the mobile top bar.
- **More reliable Find on long PDFs.** The text index is cached, so a kept query no longer briefly shows zero matches.

### Fixed
- **The text viewer no longer shifts right** inside its flex-row layout.
- **Cancelling the "restore draft" dialog no longer discards your draft** on the next edit.
- **Storage cleanup is visible.** Settings → Storage now lists files cleared by eviction.
- **Export integrity is verified.** A re-parse check runs after saving, so a corrupt export can't slip out.
- **New installs no longer pop the changelog** on first launch.
- **Sandboxed run-frame pages no longer crash** on storage or cookie access.
- **Restored-tab errors read clearly** instead of leaking internal codes, with a "re-select file" action.

## 0.1.18 · 2026-06-06

### Improved
- **Long PDFs are lighter in the thumbnail rail.** The page list now virtualizes thumbnails instead of mounting the whole document at once.
- **Compact screens stay focused on the page.** Phones, narrow windows, and portrait tablets no longer auto-open side panels over the document; larger tablets and desktops still keep the roomy layout.
- **Mobile layout polish.** Toolbars, tabs, settings, search, and reading mode handle safe areas and touch targets more consistently.

### Fixed
- **Open tabs and recent documents are more reliable.** Cached document data is kept while it is still needed, and text-document edits are flushed before switching away.
- **Android file opening handles more providers.** Markdown, HTML, PDFs, and unknown provider labels are detected more carefully, while unsupported extensions get a clearer failure path.
- **Restored PDFs land on the saved page more directly.** Reopening a document avoids the page-one flash before moving to the last reading position.

## 0.1.17 · 2026-06-05

### Fixed
- **Android direct updates now open the download.** Tapping "Download APK" in the app no longer silently does nothing.
- **Mobile recent documents are kept.** PDFs, Markdown files, and HTML files opened on iPhone, iPad, and Android now return to the Home recent list.

## 0.1.16 · 2026-05-31

### New
- **Markdown edit mode.** Markdown tabs now switch between preview and a plain-text editor, with the editor state restored with the tab.
- **Runnable HTML mode.** HTML files with scripts can be run explicitly inside a locked-down sandbox, separate from the safe static preview.
- **Mobile text-document opening.** iOS and Android now recognize PDF, Markdown, and HTML from document-picker / share-target flows more reliably.

### Improved
- **Markdown preview is lighter.** Editing no longer keeps re-rendering the preview in the background.
- **HTML run mode no longer opens to a blank white frame.** The sandbox document is created at the right point in the viewer lifecycle.
- **Text documents zoom better.** Markdown and HTML keep per-tab zoom and respond to trackpad zoom gestures.
- **Remote images are safer by default.** Markdown and HTML block remote images unless you explicitly load them.
- **Browser panel data is optional.** You can choose whether the built-in browser keeps session data such as logins between launches.

### Android
- **File opening is more reliable.** Android document intents now route PDFs, Markdown, and HTML into Shiori correctly.
- **Release builds are faster to refresh.** CI can rebuild APK-only or AAB-only artifacts, and the Android build cache is warmer.
- **Launcher icon sizing is fixed.** The adaptive icon foreground no longer over-crops the logo.

## 0.1.15 · 2026-05-30

### New
- **Tabs for documents.** Keep multiple PDFs, Markdown files, and HTML files open at once. Each tab keeps its own reading state, and your open tabs come back next time unless you close them.
- **Drag to reorder tabs.** Put your documents in the order that matches your work.
- **Markdown and HTML viewing.** Markdown now shows front matter metadata more cleanly, and HTML opens in an isolated viewer that preserves the document's own styling much better.
- **Mobile builds are prepared.** Shiori now has iPhone, iPad, and Android app packaging paths, including mobile file opening for PDF, Markdown, and HTML.

### Improved
- **Opening an already-open PDF switches tabs.** Shiori no longer adds a duplicate tab for the same document.
- **Unsupported files get clearer errors.** TXT and other unsupported formats now explain that the file type is not supported instead of saying the PDF is damaged.
- **The focus-preview button moved into the view controls.** It no longer sits alone at the very top, and it avoids the macOS traffic-light controls.
- **The tab strip scrolls without a bulky scrollbar.**
- **Dark mode keeps the logo mark readable.**

### Platforms
- **Mobile document opening includes PDF, Markdown, and HTML.** PDF editing/export remains the primary mobile workflow; Markdown and HTML open as viewers.
- **Android has two channels.** The direct APK can check Shiori's download page for updates; Google Play builds update through Google Play.
- **iOS and iPadOS use the same App Store build.** The app is prepared as one universal iPhone + iPad app.
- **Public builds no longer expire automatically after 60 days.**

## 0.1.14 · 2026-05-30

### New
- **Embedded terminal.** A new Terminal tab in the right rail opens a shell right inside Shiori — no switching to an external terminal app.
- **Embedded browser.** A new Browser tab in the right rail (also reachable from the top bar) opens web pages in place — PDF links and the address bar load here instead of popping out to your system browser. Back / forward / reload / copy link, plus a one-click "open in system browser".
- **`open <url>` in the terminal goes to the browser panel.** Running `open https://…` in the embedded terminal opens it in Shiori's browser panel; `open <file>` and `open .` still go to the system.

## 0.1.13 · 2026-05-29

### New
- **Rotate text, stamps, boxes and other annotations.** Select one and drag the round handle above it to any angle (hold Shift for free, unsnapped angles).

### Improved
- **Annotations follow page rotation.** Rotating a page now rotates the orientation of the text boxes and borders on it too.
- **Smoother Ctrl + wheel zoom.** No more jumping from 158% straight to 429% in a single notch.
- **Type an exact zoom level.** Click the percentage in the toolbar to enter a value; you can now zoom up to 800%.
- **Documents open fit-to-width.** They no longer open at the smaller actual size (clicking 100% still means actual pixel size).
- **Drag to pan.** With the select tool, drag empty page area to pan the page; hold Shift and drag to marquee-select.
- **Thumbnails don't jump when rotating.** A page's thumbnail keeps its size when rotated, so the rotate button stays put for repeated clicks.

### Fixed
- **Outline highlight stays aligned after zooming.** The highlight now tracks its heading at any zoom level.
- **Undo no longer jumps back to the page you were editing.** Edit text on a page, scroll away, and Ctrl+Z keeps your view where it is.

## 0.1.12 · 2026-05-19

### Improved
- **Desktop PDF rendering compatibility.** A handful of PDFs that previously failed to open or rendered incorrectly on desktop now work.
- **Find now scrolls to the active match.** Pressing next/previous match scrolls the page so the highlight is in view, but already-visible matches no longer cause the page to jump.
- **CJK text falls back to vector outlines on export.** When a matching font is unavailable, CJK characters are written as vector paths instead of being replaced with `?`. The resulting PDF opens normally in Preview and Adobe.
- **Missing CJK glyphs are reported.** If a character still can't be written even as a path, a toast tells you.
- **Editing preserves the PDF page origin.** Pages keep their original coordinate system after edits or export, so annotations stay where you placed them.
- **Post-export shortcuts.** The export-finished toast now offers quick actions like Open and Show in Finder.

### Fixed
- **Web recents recovery.** When the browser's file handles expire (tab idle for a long time, permission revoked), the recents list no longer silently clears or opens the wrong file — Shiori tries to recover gracefully and keeps the entry visible.
- **CJK exports no longer produce broken PDFs** when a glyph contains non-finite coordinates.

## 0.1.11 · 2026-05-16

### New
- **Edit existing PDF text.** With the Text tool active, select text on the page and edit the original wording. Exports write the replacement back as PDF page content instead of adding a normal text annotation.

### Improved
- **Replacement text better matches the source PDF.** Shiori now preserves font size, font style, weight, color, and background more closely, including serif, italic, and bold text in academic papers.
- **English word selection is more reliable.** Justified papers, hyphenated words, and words beside punctuation are less likely to pull in the previous word or miss the intended word ending.
- **Toolbar text editing.** Selected source text can be edited in place or from the toolbar text field.

### Fixed
- **Empty inserted text no longer lingers.** Pressing Escape, clicking elsewhere, or starting another text insertion removes an empty text box automatically.
- **Edited source text no longer shows a faint gray outline in normal viewing.**
- **Fixed the Linux release build.**

## 0.1.9 · 2026-05-04

### New
- **Print.** `⌘P`, toolbar button, and macOS File > Print. Prints the current document with annotations flattened in, correct page layout, and PDF filename as the default save name.
- **macOS file association.** Double-click a PDF in Finder or use "Open With" to open it directly in Shiori.
- **Password-protected PDFs.** A password dialog appears for encrypted PDFs. Wrong passwords can be retried. Once unlocked, the document works normally — editing and exporting included.

### Improved
- **Unencodable character warning on export.** If characters are replaced with '?' during export, a toast notification tells you.
- **Failed page copies during export now throw an error** instead of silently producing fewer pages.

### Fixed
- **Draft autosave listener no longer registers/unregisters repeatedly.**
- **Thumbnail render failures are now logged** instead of silently swallowed.
- **Encrypted PDFs can be merged** without crashing.

## 0.1.8 · 2026-04-28

### New
- **Recent PDFs reopen at your last page.** You no longer need to find your place from page one.
- **Outline entries can be collapsed per section.** Long tables of contents are easier to scan.
- **Delete and copy actions now show Undo feedback.** Accidental page or annotation deletes are easier to recover immediately.

### Improved
- **Escape behaves consistently in dialogs.** Settings, Export, and other modals close first instead of accidentally switching tools.
- **The thumbnail scrollbar is easier to see and grab, including in Night theme.**
- **Changing page-margin presets keeps the reading position steadier.**

### Fixed
- **Sticky notes remain editable after drag interactions.** Empty new notes no longer start accidental drags; editing notes keep focus more reliably.
- **CJK and mixed Chinese highlights have better horizontal bounds.** Large-title highlights no longer visibly overshoot as often, while normal body text avoids being clipped short.
- **Blank-canvas diagnostics are more reliable** when a PDF page reports a successful render but still appears white.
- **Complex text selections are less likely to turn into wide banner-like highlights.**

## 0.1.7 · 2026-04-27

### Improved
- **Native Apple Silicon dmg.** Previously all Mac users downloaded the same ~30 MB universal dmg; Apple Silicon users can now grab a native ARM build at ~16 MB, with faster cold start and smaller footprint. Intel Macs continue to receive the universal dmg.
- **Big-file rejection runs earlier.** PDFs over the beta open budgets (200 MB / 500 pages / oversized canvas) are now refused with a clear message before any expensive read, instead of stalling the renderer or pushing memory pressure.
- **Desktop file I/O moved to narrow Rust commands.** The frontend no longer needs broad file-system scope. Transparent to users; reduces attack surface.

## 0.1.6 · 2026-04-26

### New
- **Strikethrough text markup.** Draw a line through selected glyphs to mark deletions. Full styling, drag-to-edit, exports as a standard PDF StrikeOut annotation. Of the four standard PDF text-markup types (Highlight, Underline, StrikeOut, Squiggly), Shiori now supports three.
- **Random literary quote on the Landing page.** The bottom-of-page quote is no longer the fixed Ecclesiastes line — it rotates from a pool of ~120 classical and modern aphorisms in your UI language. A different one greets you each time you open the app.

### Improved
- **Custom colors for highlights and sticky notes.** Both tools previously locked you into a 5-swatch curated palette; now they share the same expandable picker that ink, text, and rectangles use, with recent colors remembered.
- **Resource monitor adapts to narrower layouts.** The Settings → Performance CPU / memory readout no longer collides with longer localized pressure labels.

### Fixed
- **PDF-imported annotations no longer enter the undo stack.** Opening an annotated PDF and pressing Cmd+Z would visually drop the source PDF's annotations from the overlay list (the file itself was untouched). Imported annotations are now baseline state; only your own edits enter undo history.
- **Undo / redo no longer scrolls the view back to the active page.**
- **Tool focus rings clear when switching markup modes** — no more leftover outline on the previously-selected button.

### Platforms
- macOS has been a **Universal Binary** since v0.1.5 — Apple Silicon and Intel Macs install the same `.dmg`.
- **Linux platforms** have been supported since v0.1.5: `.AppImage` (portable, with auto-update) and `.deb` (Debian / Ubuntu).

## 0.1.5 · 2026-04-26

### New
- **Underline text markup.** Like Highlight, but draws a precise line below the glyphs — full styling, drag-to-edit, exports as a standard PDF annotation.
- **macOS native menu bar.** Top menu now has Shiori / Edit / View / Window with the standard items: About, Check for Updates, Settings (⌘,), Zoom, Hide, Quit, etc.
- **Resource monitor.** Settings → Performance shows Shiori's live CPU and memory usage while you read.
- **GPU acceleration toggle.** Settings → Performance lets you turn off hardware-accelerated rendering — useful on older webviews or buggy GPU drivers.
- **Diagnostic reports on file-open errors.** A one-click copy block includes the file size, error code, and runtime context, so beta feedback is actionable in a single paste.

### Improved
- **Pinch and Cmd+wheel zoom feel smooth now.** The bitmap scales instantly during the gesture and re-renders sharp the moment the gesture settles.
- **Maximum zoom raised from 300% to 500%.** Useful for footnotes and small figures.
- **Per-file PDF limit raised to 200 MB; total draft cache raised to 1 GB.**
- **Open PDFs from anywhere on Windows.** No longer restricted to a handful of user folders.

### Fixed
- **Highlights stretching past the last glyph on justified academic PDFs.** Bounds now snap strictly to glyph metrics.
- **Narrow line endings (commas, periods) clipped under highlights or underlines.**
- **Horizontal scroll behaviour at high zoom levels.**
- **CJK text in exported PDFs wrapped or aligned incorrectly** — was using ASCII-width approximations; now uses real glyph widths.
- **CJK FreeText annotations imported from other editors keeping their original font size** instead of falling back to 14 pt.

## 0.1.4 · 2026-04-26

### New
- **Automatic update check.** Runs at launch and from Settings → Updates; new versions surface release notes in your UI language.
- **The macOS build is signed and notarized.** Developer ID Application plus Apple Notary, so the "unidentified developer" prompt is gone. The Windows build is not signed yet.

### Fixed
- **Cmd+A no longer dyes the whole page blue.** It now does what you'd expect — select text inside the text layer, or select all overlay objects on the canvas — instead of painting an opaque highlight over the entire page.
- **Active-page detection.** Scrolling no longer skips pages on the way down or sticks on the way up; the page with the most viewport overlap is treated as active.
- **Highlight rectangles no longer overshoot the last glyph.** Shiori-drawn highlights are now strictly capped to the right edge of the last visible glyph.
- **Overlapping highlight quads coalesce.** Painting twice over the same area no longer compounds into a dark band; imported highlights are also opacity-capped at 0.6.
- **Thumbnail rail now shows your annotations.** Ink, text boxes, stamps, and highlights now appear in the left-rail thumbnails alongside the original PDF content.
- **Thumbnail tiles use paper white.** They no longer recolour with the theme — every thumbnail looks like a real page.
- **Modal close buttons no longer get squeezed out of view.** Long changelogs can scroll freely without burying the close button.
- **Selected highlights have a visible outline.** Clicking an existing highlight now shows a clear selection border, and the bogus drag-to-resize handles (which never made semantic sense for text markup) are gone.

### Improved
- **Release notes follow your UI language.** Switching to Chinese or Japanese surfaces the matching version of the update modal text.
- **Beta kill-switch extended to 60 days** so beta installs survive longer.

## 0.1.2 · 2026-04-25

### Fixed
- **Jagged monospace text on Windows** — page counts, file sizes, keyboard shortcuts, and other fixed-width labels now render cleanly.

### Improved
- **Consistent UI typography across Mac, Windows, and Linux.** Inter Tight (body), JetBrains Mono (numbers / code), Instrument Serif (headings), and the Klee One + Shippori Mincho brand faces for "栞 Shiori" ship inside the app — no system-installed fonts required.
- **UI fonts now track the selected interface language.** Previously only the changelog modal actually used the Chinese / Japanese font stacks; now the entire chrome follows whatever language you set.
- **Better Japanese UI fallback on Windows.** English-locale Windows installs without the Japanese Supplemental Fonts pack no longer show the Japanese UI as tofu squares.

## 0.1.1 · 2026-04-24

### New
- **Redesigned landing page.** New hero layout, a recent-documents list with PDF first-page thumbnails, and corner widgets for language, theme, and version number.
- **Trackpad pinch-to-zoom** on PDF pages. The scroll position stays anchored to the page under your fingers, so the view doesn't jump while you zoom.
- **In-document Find panel.** `Cmd/Ctrl+F` opens full-text search and matches light up in the theme color.
- **Direct text selection.** Drag across text on any PDF to highlight it — no need to switch to the highlight tool first.
- **Clickable PDF hyperlinks.** External links and internal jumps embedded in the PDF are now openable straight from the viewer.
- **Precise outline jumps.** Click a highlight to jump to its matching outline entry, with an in-PDF marker pointing at the destination.
- **Arrow-key navigation in the thumbnail rail.** Focus the left rail and use `↑ / ↓` to move through pages.
- **Shortcuts sheet from the landing page.** Press `?` or `Cmd/Ctrl+Shift+?` on the Landing to open the keyboard reference.
- **Copy and search honor replacement text when the PDF runtime exposes it.** This improves encoded glyphs and some ligatures. Scanned pages still need OCR, and general PDF `/ActualText` is not guaranteed by the current pdf.js API.
- **Check / cross stamps.** Place ✓ or ✗ into a form with one click. Color and stroke weight are adjustable.
- **Click the version number** in the corner to read the full changelog, and get notified automatically when a new version ships.
- **Highlight drag preview on scanned PDFs.** Pages without extractable text now show a semi-transparent rectangle previewing what you're about to mark.

### Fixed
- **Highlights across column gutters** split cleanly instead of smearing through the gap — a big help on two-column papers.
- **Overlapping same-color highlights merge on draw**, and re-highlighting the same text toggles it off.
- **Default cursor on text highlights.** No more move-grab handle where one doesn't belong.
- **Text highlights are no longer drag-movable.** They belong to the text underneath and move with it.
- **Pinch-zoom pauses text selection**, so two-finger gestures don't accidentally select text mid-zoom.
- **Outline entries drop the trailing page number**, and the in-outline marker widens to sit over the full heading.
- **Current page uses max-viewport overlap** instead of the first unexpired edge, so scrolling no longer jumps the page label around.
- **CJK glyphs render correctly.** Chinese is no longer shown with Japanese variants, Japanese no longer falls through to the wrong face, and pdf.js CMap + standard-font assets now ship with the app.
- **Broader PDF-viewer compatibility** for exported files.
- **Edited exports preserve outlines and named destinations**, so bookmarks and internal links still work after round-tripping.
- **Read-only opens don't rewrite the PDF** when you haven't made any edits.
- **CJK annotation exports stay compact** — no more massive font embed.
- **Text selection works on macOS.** Dragging over text under the highlight tool previously did nothing on Mac; fixed.
- **Highlight no longer swallows the whole page** from rapid clicks or a double-click on blank space.
- **Multi-line highlights render at uniform opacity** — no more darker bands where line rectangles overlap.
- **Ink color / width changes apply immediately** to the next stroke, instead of lagging one stroke behind.
- **Shortcut labels on Windows** now read `Ctrl+Shift+Z` in the familiar order (was `Shift Ctrl Z`).

### Changed
- **New palette.** Cool-white paper with a #3388BB accent blue; the brand tile and OS icons have been rebranded to match.
- **Draft cache raised to 200 MB** and managed from the status bar.
- **Every annotation tool remembers its last used style.** Ink, rectangle, highlight, note, and text all carry color / weight / size forward into the next annotation you draw.
- **Drag previews across every tool are now WYSIWYG.** The rectangle, highlight, note, and text-box previews look like the final annotation while you drag, instead of a shared dashed placeholder.
- **Settings panel palettes expanded.** Ink supports custom colors; the sticky-note palette grew to 5 colors, matching the toolbar.
- **Text size cap unified at 144 pt** across the default toolbar and the selected-text controls.

---

## 0.1.0 · 2026-04-21

First beta release of Shiori.
