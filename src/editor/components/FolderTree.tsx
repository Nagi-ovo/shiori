import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { listFolderEntriesFromPlatform } from "../../platform";
import type { FolderEntry, FolderListing } from "../../platform";
import { documentKindShortLabel } from "../../documents/types";

/**
 * The mounted folder, read straight off disk.
 *
 * Nothing is cached between openings: a stored tree is a tree that lies the
 * moment the reader moves a file in Finder. Each directory is read when it is
 * expanded and forgotten when it collapses, so mounting a folder of two
 * thousand papers costs one listing, not a disk walk.
 *
 * This is the "cold" half of the documents view. The reader has not opened
 * these files; they are simply there. Clicking one opens it, which is the only
 * thing that moves a file from here into the reading side.
 *
 * Structure is drawn the way Obsidian draws it, because that is what makes a
 * deep tree readable: the mounted folder is a row of its own at the top, and
 * each nested level carries a vertical guide line back to its parent.
 * Indentation on its own leaves the reader counting pixels.
 */

/** Indent per level. The guide line sits on the left edge of this gutter. */
const INDENT_PX = 14;

export function FolderTree({
  path,
  activePath,
  previewTabIdsByPath,
  onOpenFile,
  onUnmount,
}: {
  /** Absolute path of the mounted folder. */
  path: string;
  /** Path of the document currently being read, if any — highlights its row. */
  activePath?: string;
  /** Open tabs keyed by path; cold files deliberately have no entry. */
  previewTabIdsByPath?: ReadonlyMap<string, string>;
  onOpenFile: (entry: FolderEntry) => void;
  onUnmount: () => void;
}) {
  const { t } = useTranslation();
  // The root starts open: the reader just chose this folder, so hiding its
  // contents behind one more click asks them to confirm it twice.
  const [open, setOpen] = useState(true);
  // Closing the folder is rare and destructive-looking, so it lives on the
  // right-click menu rather than as a permanent × next to the folder's name —
  // a button you press once a month should not sit beside one you press all
  // day.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // Where focus came from, so closing the menu returns it there rather than
  // dropping it on the document body.
  const menuOpenerRef = useRef<HTMLElement | null>(null);
  const menuItemRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback(() => {
    setMenuAt(null);
    menuOpenerRef.current?.focus();
    menuOpenerRef.current = null;
  }, []);
  useEffect(() => {
    if (!menuAt) return;
    // No global keydown listener. Escape is handled on the menu itself (see
    // onKeyDown below), because a window-level one keeps intercepting after
    // focus has moved on: open the menu, open the Shortcuts modal on top of
    // it, and one Escape would have closed both and yanked focus back to the
    // folder row. The previous any-key dismissal had the opposite fault —
    // the first Tab or arrow closed the menu, so its single item could never
    // be reached by keyboard at all.
    // A press inside the menu is not a dismissal — it is the click that is
    // about to happen. pointerdown runs before click, so dismissing
    // unconditionally unmounted the item and its onClick never fired: the
    // menu's only action was dead to every pointer, and worked by keyboard
    // alone.
    const dismiss = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setMenuAt(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menuAt]);
  // Focus the item when the menu opens: it is what makes the menu operable
  // from the keyboard, and what gives Escape something to return from.
  useEffect(() => {
    if (!menuAt) return;
    menuItemRef.current?.focus();
  }, [menuAt]);

  return (
    <>
      <Row
        label={folderName(path)}
        title={path}
        isDirectory
        expanded={open}
        onActivate={() => setOpen((current) => !current)}
        onContextMenu={(event) => {
          event.preventDefault();
          menuOpenerRef.current = event.currentTarget as HTMLElement;
          setMenuAt({ x: event.clientX, y: event.clientY });
        }}
        // The keyboard's own "open the context menu": Shift+F10 everywhere,
        // plus the dedicated Menu key on keyboards that have one. macOS has
        // neither key by default, so the row answers Ctrl+Enter as well —
        // otherwise this action stays mouse-only on the platform Shiori is
        // developed on.
        onContextMenuKey={(rect, target) => {
          menuOpenerRef.current = target;
          setMenuAt({ x: rect.left + 8, y: rect.bottom + 2 });
        }}
      />
      {menuAt ? (
        <div
          role="menu"
          ref={menuRef}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
          }}
          // Focus leaving the menu dismisses it, but silently: whatever the
          // reader tabbed to keeps focus. Only Escape hands focus back to the
          // row it came from.
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            menuOpenerRef.current = null;
            setMenuAt(null);
          }}
          style={{
            position: "fixed",
            left: Math.min(menuAt.x, window.innerWidth - 190),
            top: Math.min(menuAt.y, window.innerHeight - 60),
            zIndex: 70,
            minWidth: 170,
            padding: 4,
            background: T.surface,
            border: `1px solid ${T.rule}`,
            borderRadius: 7,
            boxShadow: "0 10px 28px rgba(19,22,29,0.16)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            ref={menuItemRef}
            onClick={() => {
              setMenuAt(null);
              menuOpenerRef.current = null;
              onUnmount();
            }}
            style={{
              appearance: "none",
              display: "block",
              width: "100%",
              border: "none",
              background: "transparent",
              padding: "6px 9px",
              borderRadius: 5,
              cursor: "pointer",
              textAlign: "left",
              font: `500 12px/1.4 ${T.sans}`,
              color: T.ink,
            }}
          >
            {t("documentTree.unmountFolder")}
          </button>
        </div>
      ) : null}
      {open ? (
        <Nested>
          <FolderLevel
            path={path}
            activePath={activePath}
            previewTabIdsByPath={previewTabIdsByPath}
            onOpenFile={onOpenFile}
          />
        </Nested>
      ) : null}
    </>
  );
}

/** One level's indent plus the guide line that ties it to its parent. */
function Nested({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginLeft: INDENT_PX, borderLeft: `1px solid ${T.ruleSoft}` }}>
      {children}
    </div>
  );
}

function FolderLevel({
  path,
  activePath,
  previewTabIdsByPath,
  onOpenFile,
}: {
  path: string;
  activePath?: string;
  previewTabIdsByPath?: ReadonlyMap<string, string>;
  onOpenFile: (entry: FolderEntry) => void;
}) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  // A counter rather than a callback that resets state on the spot: the retry
  // has to re-run the effect, and setting state synchronously inside an effect
  // is what the hooks rule (rightly) rejects.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void listFolderEntriesFromPlatform(path)
      .then((result) => {
        if (cancelled) return;
        // A null result means the platform cannot list directories at all,
        // which the caller should already have gated on — treat it the same as
        // a read failure rather than rendering an empty folder that is not.
        if (!result) setError(true);
        else {
          setError(false);
          setListing(result);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  if (error) {
    return (
      <Message
        text={t("folderTree.unreadable")}
        action={{
          label: t("folderTree.retry"),
          onClick: () => setReloadKey((key) => key + 1),
        }}
      />
    );
  }
  if (!listing) return <Message text={t("folderTree.loading")} />;
  if (listing.entries.length === 0) {
    return <Message text={t("folderTree.empty")} />;
  }

  const toggle = (entryPath: string) =>
    setExpanded((current) =>
      current.includes(entryPath)
        ? current.filter((item) => item !== entryPath)
        : [...current, entryPath],
    );

  return (
    <>
      {listing.entries.map((entry) => {
        const isOpen = expanded.includes(entry.path);
        const active = !entry.isDirectory && entry.path === activePath;
        const hovered = hoverPath === entry.path;
        return (
          <div key={entry.path}>
            <Row
              label={entry.name}
              title={entry.path}
              isDirectory={entry.isDirectory}
              expanded={isOpen}
              active={active}
              hovered={hovered}
              kind={entry.kind ? documentKindShortLabel(entry.kind) : undefined}
              preview={
                entry.isDirectory
                  ? undefined
                  : {
                      heading: entry.kind
                        ? documentKindShortLabel(entry.kind)
                        : "",
                      body: entry.name,
                    }
              }
              previewTabId={previewTabIdsByPath?.get(entry.path)}
              onActivate={() =>
                entry.isDirectory ? toggle(entry.path) : onOpenFile(entry)
              }
              onHoverChange={(nextHovered) =>
                setHoverPath((current) =>
                  nextHovered
                    ? entry.path
                    : current === entry.path
                      ? null
                      : current,
                )
              }
            />
            {entry.isDirectory && isOpen ? (
              <Nested>
                <FolderLevel
                  path={entry.path}
                  activePath={activePath}
                  previewTabIdsByPath={previewTabIdsByPath}
                  onOpenFile={onOpenFile}
                />
              </Nested>
            ) : null}
          </div>
        );
      })}
      {/* Say so rather than look complete: a folder past the cap would
          otherwise appear to hold exactly the cap's worth of files. */}
      {listing.truncated ? <Message text={t("folderTree.truncated")} /> : null}
    </>
  );
}

function Row({
  label,
  title,
  isDirectory,
  expanded,
  active = false,
  hovered = false,
  kind,
  preview,
  previewTabId,
  onActivate,
  onHoverChange,
  onContextMenu,
  onContextMenuKey,
}: {
  label: string;
  title: string;
  isDirectory: boolean;
  expanded: boolean;
  active?: boolean;
  hovered?: boolean;
  kind?: string;
  preview?: { heading: string; body: string; note?: string };
  previewTabId?: string;
  onActivate: () => void;
  onHoverChange?: (hovered: boolean) => void;
  onContextMenu?: (event: MouseEvent) => void;
  /** Keyboard equivalent of onContextMenu; gets the row's rect to anchor to. */
  onContextMenuKey?: (rect: DOMRect, target: HTMLElement) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      // File rows use the immediate workspace preview. Leaving a native
      // title here creates a second tooltip roughly a second later.
      title={preview ? undefined : title}
      data-workspace-preview-id={preview ? title : undefined}
      data-workspace-preview-tab-id={previewTabId}
      data-workspace-preview-heading={preview?.heading}
      data-workspace-preview-body={preview?.body}
      data-workspace-preview-note={preview?.note}
      aria-describedby={preview ? "workspace-row-preview" : undefined}
      aria-expanded={isDirectory ? expanded : undefined}
      aria-current={active}
      onClick={onActivate}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (
          onContextMenuKey &&
          (event.key === "ContextMenu" ||
            (event.key === "F10" && event.shiftKey) ||
            (event.key === "Enter" && event.ctrlKey))
        ) {
          event.preventDefault();
          onContextMenuKey(
            event.currentTarget.getBoundingClientRect(),
            event.currentTarget,
          );
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onActivate();
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      onFocus={() => onHoverChange?.(true)}
      onBlur={() => onHoverChange?.(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "12px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 5,
        padding: "4px 7px 4px 5px",
        margin: "0 4px 1px",
        borderRadius: 5,
        cursor: "pointer",
        background: active ? T.accentSoft : hovered ? T.paper : "transparent",
      }}
    >
      {isDirectory ? (
        <svg
          width="9"
          height="9"
          viewBox="0 0 8 8"
          fill="none"
          aria-hidden
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 140ms ease",
            color: T.dim,
          }}
        >
          <path
            d="M2.5 1L6 4L2.5 7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <span aria-hidden />
      )}
      <span
        style={{
          minWidth: 0,
          // Filenames are this panel's content, not its chrome. At 400 weight
          // in the muted ink they read as a caption for something else.
          font: `${active ? 600 : 500} 12.5px/1.55 ${T.sans}`,
          color: active || isDirectory ? T.ink : T.ink2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {/* Kind at the right edge, same as every other row in the navigator, so
          names stay left-aligned down the whole column. */}
      <span
        style={{
          font: `500 9px/1.6 ${T.mono}`,
          letterSpacing: ".06em",
          color: T.dim,
          flex: "none",
        }}
      >
        {kind ?? ""}
      </span>
    </div>
  );
}

function Message({
  text,
  action,
}: {
  text: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <p
      style={{
        margin: 0,
        padding: "5px 10px 5px 12px",
        font: `400 11px/1.5 ${T.sans}`,
        color: T.dim,
      }}
    >
      {text}
      {action ? (
        <>
          {" "}
          <button
            type="button"
            onClick={action.onClick}
            style={{
              appearance: "none",
              border: "none",
              background: "transparent",
              padding: 0,
              margin: 0,
              cursor: "pointer",
              font: "inherit",
              color: T.accentText,
              textDecoration: "underline",
            }}
          >
            {action.label}
          </button>
        </>
      ) : null}
    </p>
  );
}

function folderName(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
