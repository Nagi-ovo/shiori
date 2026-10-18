import type { SVGProps } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  ArrowRight,
  Bold,
  BookOpen,
  BookMarked,
  Bookmark,
  Check,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
  Download,
  Ellipsis,
  ExternalLink,
  FileInput,
  FilePlus2,
  FileStack,
  FolderOpen,
  Globe2,
  Heart,
  Highlighter,
  Italic,
  Keyboard,
  List,
  ListCollapse,
  Languages,
  Lock,
  MessageSquare,
  Moon,
  MousePointer2,
  MoveHorizontal,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Printer,
  Redo2,
  RefreshCw,
  RotateCw,
  Scan,
  Search,
  Settings,
  Signature,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  Sun,
  Terminal,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

// Shiori uses Lucide as its system icon vocabulary. The existing `Ic.xxx`
// facade stays stable so product code speaks in Shiori concepts rather than
// depending on upstream component names. Domain-specific glyphs can remain
// local as long as they follow the same Lucide geometry contract:
//
//   • 24×24 viewBox with at least 1 unit of padding
//   • stroke width 2, round caps and round joins
//   • 2 units between distinct elements
//   • 18px default render size
//
// Prefer `fromLucide` for generic interface actions. Draw locally only when a
// library metaphor would collide with another Shiori tool or lose meaning.

type IcProps = Omit<SVGProps<SVGSVGElement>, "ref">;

const base: IcProps = {
  width: 18,
  height: 18,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  // Every icon here is decorative: it sits inside a control that carries the
  // name (IconBtn promotes its title to aria-label). Left exposed, the glyph
  // is one more unnamed graphic for a screen reader to step over, and in a
  // toolbar of twenty that is twenty stops of noise. Callers that need a
  // named graphic can override this.
  "aria-hidden": true,
};

function fromLucide(Icon: LucideIcon) {
  return (props: IcProps = {}) => (
    <Icon size={18} strokeWidth={2} aria-hidden {...props} />
  );
}

export const Ic = {
  // Creation and annotation tools
  cursor: fromLucide(MousePointer2),
  highlight: fromLucide(Highlighter),
  underline: fromLucide(Underline),
  strikethrough: fromLucide(Strikethrough),
  // A freehand stroke reads more directly as PDF ink than Lucide's pen tools.
  ink: (props: IcProps = {}) => (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M4 17C7 5 11 5 12.5 12S17 19 20 7" />
    </svg>
  ),
  signature: fromLucide(Signature),
  stamp: fromLucide(Stamp),
  rect: fromLucide(Square),
  note: fromLucide(StickyNote),
  callout: fromLucide(MessageSquare),
  text: fromLucide(Type),

  // Navigator views
  // Use four distinct silhouettes here: collection, hierarchy, page stack,
  // and marked reading. At 20px these stay legible without relying on colour.
  viewDocuments: fromLucide(FolderOpen),
  viewOutline: fromLucide(ListCollapse),
  viewPages: fromLucide(FileStack),
  viewMarks: fromLucide(BookMarked),

  // View and zoom
  zoomIn: fromLucide(ZoomIn),
  zoomOut: fromLucide(ZoomOut),
  search: fromLucide(Search),
  fit: fromLucide(MoveHorizontal),
  reader: fromLucide(Scan),
  thumbs: fromLucide(PanelLeft),
  navigatorOpen: fromLucide(PanelLeftOpen),
  navigatorClose: fromLucide(PanelLeftClose),
  outline: fromLucide(List),
  bookOpen: fromLucide(BookOpen),

  // Edit and document
  undo: fromLucide(Undo2),
  redo: fromLucide(Redo2),
  rotate: fromLucide(RotateCw),
  refresh: fromLucide(RefreshCw),
  copy: fromLucide(Copy),
  dup: fromLucide(CopyPlus),
  fileInput: fromLucide(FileInput),
  filePlus: fromLucide(FilePlus2),
  trash: fromLucide(Trash2),
  lock: fromLucide(Lock),
  edit: fromLucide(Pencil),
  collapse: fromLucide(PanelLeftClose),
  bookmark: fromLucide(Bookmark),

  // Common controls
  check: fromLucide(Check),
  alert: fromLucide(CircleAlert),
  x: fromLucide(X),
  plus: fromLucide(Plus),
  chev: fromLucide(ChevronRight),
  chevDown: fromLucide(ChevronDown),
  arrowLeft: fromLucide(ArrowLeft),
  arrowRight: fromLucide(ArrowRight),
  ellipsis: fromLucide(Ellipsis),

  // System and external
  settings: fromLucide(Settings),
  kbd: fromLucide(Keyboard),
  printer: fromLucide(Printer),
  download: fromLucide(Download),
  terminal: fromLucide(Terminal),
  globe: fromLucide(Globe2),
  language: fromLucide(Languages),
  moon: fromLucide(Moon),
  sun: fromLucide(Sun),
  external: fromLucide(ExternalLink),
  heart: fromLucide(Heart),

  // Text formatting
  bold: fromLucide(Bold),
  italic: fromLucide(Italic),
  alignL: fromLucide(AlignLeft),
  alignC: fromLucide(AlignCenter),
  alignR: fromLucide(AlignRight),
};
