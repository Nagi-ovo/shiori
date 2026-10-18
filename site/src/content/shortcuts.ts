// Site-side mirror of the in-app shortcuts sheet. Source of truth for
// row labels: `src/i18n/locales/{en,zh,ja}.json` under `shortcuts.rows`,
// and for chord assignments: `src/editor/components/ShortcutsSheet.tsx`
// GROUPS constant. Duplicated here intentionally so the public site
// stays a standalone Vite project and doesn't pull from the app tree.

import type { Lang } from "../i18n/dict";

export type RowKey =
  | "select"
  | "markup"
  | "ink"
  | "stamp"
  | "rect"
  | "callout"
  | "signature"
  | "text"
  | "undo"
  | "redo"
  | "deleteSel"
  | "copy"
  | "paste"
  | "duplicate"
  | "selectAll"
  | "nudge"
  | "rotate"
  | "print"
  | "find"
  | "nextPrev"
  | "goto"
  | "pan"
  | "zoomIn"
  | "zoomOut"
  | "fit"
  | "actual"
  | "readerMode";

export type GroupId = "tools" | "edit" | "navigation" | "zoom";

export type Group = {
  id: GroupId;
  rows: ReadonlyArray<{ keys: string; rowKey: RowKey }>;
};

// Chord strings use the macOS menu-bar convention. Kbd handles
// translation to Ctrl/Alt on PC. `/` inside a chord is a literal "or"
// separator (alternative key combos).
export const GROUPS: ReadonlyArray<Group> = [
  {
    id: "tools",
    rows: [
      { keys: "V", rowKey: "select" },
      { keys: "H / U / ⇧ U", rowKey: "markup" },
      { keys: "I", rowKey: "ink" },
      { keys: "C", rowKey: "callout" },
      { keys: "G", rowKey: "signature" },
      { keys: "S", rowKey: "stamp" },
      { keys: "R", rowKey: "rect" },
      { keys: "T", rowKey: "text" },
    ],
  },
  {
    id: "edit",
    rows: [
      { keys: "⌘ Z", rowKey: "undo" },
      { keys: "⇧ ⌘ Z", rowKey: "redo" },
      { keys: "⌫", rowKey: "deleteSel" },
      { keys: "⌘ C", rowKey: "copy" },
      { keys: "⌘ V", rowKey: "paste" },
      { keys: "⌘ D", rowKey: "duplicate" },
      { keys: "⌘ A", rowKey: "selectAll" },
      { keys: "↑ ↓ ← →", rowKey: "nudge" },
      { keys: "⇧", rowKey: "rotate" },
      { keys: "⌘ P", rowKey: "print" },
      { keys: "⌘ F", rowKey: "find" },
    ],
  },
  {
    id: "navigation",
    rows: [
      { keys: "J / K", rowKey: "nextPrev" },
      { keys: "⌘ G", rowKey: "goto" },
      { keys: "Space", rowKey: "pan" },
    ],
  },
  {
    id: "zoom",
    rows: [
      { keys: "⌘ +", rowKey: "zoomIn" },
      { keys: "⌘ −", rowKey: "zoomOut" },
      { keys: "⌘ 0", rowKey: "fit" },
      { keys: "⌘ 1", rowKey: "actual" },
      { keys: "⌘ \\", rowKey: "readerMode" },
    ],
  },
];

type Copy = {
  groups: Record<GroupId, string>;
  rows: Record<RowKey, string>;
};

export const SHORTCUT_COPY: Record<Lang, Copy> = {
  en: {
    groups: {
      tools: "Tools",
      edit: "Edit",
      navigation: "Navigation",
      zoom: "Zoom",
    },
    rows: {
      select: "Select",
      markup: "Highlight / Underline / Strikethrough",
      ink: "Ink / pen",
      stamp: "Stamp",
      rect: "Rectangle",
      callout: "Comment callout",
      signature: "Signature",
      text: "Text",
      undo: "Undo",
      redo: "Redo",
      deleteSel: "Delete selection",
      copy: "Copy annotation",
      paste: "Paste annotation",
      duplicate: "Duplicate",
      selectAll: "Select all on page",
      nudge: "Move selection",
      rotate: "Rotate while dragging a handle",
      print: "Print",
      find: "Find in document",
      nextPrev: "Next / previous page",
      goto: "Go to page…",
      pan: "Hold to pan",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      fit: "Fit width",
      actual: "Actual size",
      readerMode: "Toggle reader mode",
    },
  },
  zh: {
    groups: {
      tools: "工具",
      edit: "编辑",
      navigation: "导航",
      zoom: "缩放",
    },
    rows: {
      select: "选择",
      markup: "高亮 / 下划线 / 删除线",
      ink: "画笔",
      stamp: "勾叉印章",
      rect: "矩形",
      callout: "批注引线",
      signature: "签名",
      text: "文字",
      undo: "撤销",
      redo: "重做",
      deleteSel: "删除所选",
      copy: "复制注释",
      paste: "粘贴注释",
      duplicate: "复制",
      selectAll: "选中当前页所有",
      nudge: "移动所选",
      rotate: "拖动控制点时旋转",
      print: "打印",
      find: "在文档中查找",
      nextPrev: "下一页 / 上一页",
      goto: "跳转到页…",
      pan: "按住拖动平移",
      zoomIn: "放大",
      zoomOut: "缩小",
      fit: "适应宽度",
      actual: "原始大小",
      readerMode: "切换纯净阅读模式",
    },
  },
  ja: {
    groups: {
      tools: "ツール",
      edit: "編集",
      navigation: "ナビゲーション",
      zoom: "ズーム",
    },
    rows: {
      select: "選択",
      markup: "ハイライト / 下線 / 取り消し線",
      ink: "ペン / 手書き",
      stamp: "チェック印",
      rect: "矩形",
      callout: "引き出しコメント",
      signature: "署名",
      text: "テキスト",
      undo: "取り消し",
      redo: "やり直し",
      deleteSel: "選択を削除",
      copy: "注釈をコピー",
      paste: "注釈を貼り付け",
      duplicate: "複製",
      selectAll: "ページ内をすべて選択",
      nudge: "選択を移動",
      rotate: "ハンドルのドラッグ中に回転",
      print: "印刷",
      find: "文書内を検索",
      nextPrev: "次 / 前のページ",
      goto: "ページへジャンプ…",
      pan: "長押しでパン",
      zoomIn: "ズームイン",
      zoomOut: "ズームアウト",
      fit: "幅に合わせる",
      actual: "実寸",
      readerMode: "リーダーモードを切り替え",
    },
  },
};
