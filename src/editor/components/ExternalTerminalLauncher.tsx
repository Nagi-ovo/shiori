import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  listExternalTerminals,
  normalizeExternalTerminalApps,
  openExternalTerminal,
} from "../../platform";
import { T } from "../../design/tokens";
import { toast } from "../toast";
import {
  useAppStore,
  type PrefsExternalTerminalId,
} from "../store/store";
import { Ic } from "./icons";
import {
  resolvePreferredExternalTerminal,
  type ExternalTerminalApp,
} from "./externalTerminalLauncherModel";

type Props = {
  workingDirectory: string | null;
  /** Test seam; production always uses the platform abstraction. */
  listTerminals?: () => Promise<ExternalTerminalApp[]>;
  /** Test seam; production always uses the platform abstraction. */
  openTerminal?: typeof openExternalTerminal;
};

type LoadState = "loading" | "ready" | "error";
type InitialFocus = "selected" | "first" | "last";

export function ExternalTerminalLauncher({
  workingDirectory,
  listTerminals = listExternalTerminals,
  openTerminal = openExternalTerminal,
}: Props) {
  const { t } = useTranslation();
  const preferredId = useAppStore((state) => state.prefs.preferredExternalTerminalId);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const [terminals, setTerminals] = useState<ExternalTerminalApp[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [menuOpen, setMenuOpen] = useState(false);
  const [openingId, setOpeningId] = useState<PrefsExternalTerminalId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const chooserRef = useRef<HTMLButtonElement>(null);
  const requestIdRef = useRef(0);
  const openingIdRef = useRef<PrefsExternalTerminalId | null>(null);
  const initialFocusRef = useRef<InitialFocus>("selected");
  const translationRef = useRef(t);

  useLayoutEffect(() => {
    translationRef.current = t;
  }, [t]);

  const selectedTerminal = useMemo(
    () => resolvePreferredExternalTerminal(terminals, preferredId),
    [preferredId, terminals],
  );

  const refreshTerminals = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadState("loading");
    try {
      const discovered = normalizeExternalTerminalApps(await listTerminals());
      if (requestId !== requestIdRef.current) return;
      setTerminals(discovered);
      setLoadState("ready");
    } catch {
      if (requestId !== requestIdRef.current) return;
      setTerminals([]);
      setLoadState("error");
      toast.error(
        translationRef.current("terminal.external.discoveryFailed"),
        translationRef.current("terminal.external.discoveryFailedDetail"),
      );
    }
  }, [listTerminals]);

  useEffect(() => {
    const handle = window.setTimeout(() => void refreshTerminals(), 0);
    return () => {
      window.clearTimeout(handle);
      requestIdRef.current += 1;
    };
  }, [refreshTerminals]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      chooserRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const controls = menuControls(menuRef.current);
    if (controls.length === 0) {
      menuRef.current?.focus();
      return;
    }
    if (initialFocusRef.current === "first") {
      controls[0]?.focus();
      return;
    }
    if (initialFocusRef.current === "last") {
      controls.at(-1)?.focus();
      return;
    }
    const selectedIndex = selectedTerminal
      ? terminals.findIndex((terminal) => terminal.id === selectedTerminal.id)
      : -1;
    controls[Math.max(0, selectedIndex)]?.focus();
  }, [menuOpen, selectedTerminal, terminals]);

  const openMenu = (focus: InitialFocus = "selected") => {
    initialFocusRef.current = focus;
    setMenuOpen(true);
  };

  const launch = useCallback(
    async (terminal: ExternalTerminalApp) => {
      if (openingIdRef.current) return;
      openingIdRef.current = terminal.id;
      setMenuOpen(false);
      setOpeningId(terminal.id);
      try {
        await openTerminal(terminal.id, workingDirectory);
        setPrefs({ preferredExternalTerminalId: terminal.id });
      } catch {
        toast.error(
          t("terminal.external.openFailed", { name: terminal.name }),
          t("terminal.external.openFailedDetail"),
        );
      } finally {
        openingIdRef.current = null;
        setOpeningId(null);
      }
    },
    [openTerminal, setPrefs, t, workingDirectory],
  );

  const onChooserKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openMenu(event.key === "ArrowUp" ? "last" : "first");
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      // A menu is one composite tab stop: arrows move within it, while Tab
      // dismisses it and continues through the surrounding terminal UI.
      setMenuOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const controls = menuControls(menuRef.current);
    if (controls.length === 0) return;
    event.preventDefault();
    const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") {
      controls[0]?.focus();
      return;
    }
    if (event.key === "End") {
      controls.at(-1)?.focus();
      return;
    }
    const delta = event.key === "ArrowUp" ? -1 : 1;
    const nextIndex = (Math.max(0, currentIndex) + delta + controls.length) % controls.length;
    controls[nextIndex]?.focus();
  };

  const busy = loadState === "loading" || openingId !== null;
  const primaryLabel = selectedTerminal
    ? t("terminal.external.openIn", { name: selectedTerminal.name })
    : loadState === "loading"
      ? t("terminal.external.loading")
      : t("terminal.external.noneAvailable");

  return (
    <div
      ref={rootRef}
      className="shioriExternalTerminalLauncher"
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setMenuOpen(false);
        }
      }}
    >
      <style>{`
        .shioriExternalTerminalLauncher button:focus-visible {
          outline: 2px solid ${T.accent};
          outline-offset: 2px;
        }
        .shioriExternalTerminalPrimary:hover:not(:disabled),
        .shioriExternalTerminalChooser:hover:not(:disabled) {
          background: ${T.hoverTint} !important;
          color: ${T.ink} !important;
        }
        .shioriExternalTerminalPrimary:active:not(:disabled),
        .shioriExternalTerminalChooser:active:not(:disabled),
        .shioriExternalTerminalMenuItem:active:not(:disabled) {
          transform: translateY(1px);
        }
        .shioriExternalTerminalMenuItem:hover:not(:disabled),
        .shioriExternalTerminalMenuItem:focus-visible {
          background: ${T.hoverTint} !important;
          color: ${T.ink} !important;
        }
      `}</style>
      <button
        type="button"
        className="shioriExternalTerminalPrimary"
        aria-label={primaryLabel}
        title={primaryLabel}
        aria-busy={busy}
        disabled={!selectedTerminal || busy}
        onClick={() => {
          if (selectedTerminal) void launch(selectedTerminal);
        }}
        style={splitButtonStyle("primary", menuOpen)}
      >
        <ExternalTerminalIcon
          terminal={selectedTerminal}
          size={18}
          subdued={!selectedTerminal || loadState === "loading"}
        />
      </button>
      <button
        ref={chooserRef}
        type="button"
        className="shioriExternalTerminalChooser"
        aria-label={t("terminal.external.choose")}
        title={t("terminal.external.choose")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? "external-terminal-menu" : undefined}
        disabled={busy}
        onKeyDown={onChooserKeyDown}
        onClick={() => {
          if (menuOpen) setMenuOpen(false);
          else openMenu();
        }}
        style={splitButtonStyle("chooser", menuOpen)}
      >
        <Ic.chev
          aria-hidden
          style={{
            width: 10,
            height: 10,
            transform: `rotate(${menuOpen ? -90 : 90}deg)`,
            transition: "transform 140ms cubic-bezier(.16,1,.3,1)",
          }}
        />
      </button>

      {menuOpen ? (
        <div
          ref={menuRef}
          id="external-terminal-menu"
          role="menu"
          tabIndex={-1}
          aria-label={t("terminal.external.menuLabel")}
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 8,
            width: 214,
            maxWidth: "calc(100vw - 24px)",
            boxSizing: "border-box",
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            border: `1px solid ${T.rule}`,
            borderRadius: 10,
            background: T.surface,
            boxShadow:
              "0 14px 34px -14px rgba(38,32,24,.28), 0 3px 10px rgba(38,32,24,.08)",
          }}
        >
          {terminals.map((terminal) => {
            const selected = terminal.id === selectedTerminal?.id;
            return (
              <button
                key={terminal.id}
                type="button"
                className="shioriExternalTerminalMenuItem"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={selected}
                disabled={openingId !== null}
                onClick={() => void launch(terminal)}
                style={{
                  width: "100%",
                  minHeight: 34,
                  padding: "6px 8px",
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  border: "none",
                  borderRadius: 6,
                  background: selected ? T.accentGhost : "transparent",
                  color: selected ? T.accentText : T.ink,
                  cursor: "pointer",
                  font: `500 13px/1.2 ${T.sans}`,
                  letterSpacing: 0,
                  textAlign: "left",
                  transition:
                    "background 120ms ease, color 120ms ease, transform 90ms ease",
                }}
              >
                <ExternalTerminalIcon terminal={terminal} />
                <span style={{ flex: 1, minWidth: 0 }}>{terminal.name}</span>
                {selected ? (
                  <Ic.check aria-hidden style={{ width: 13, height: 13, flex: "0 0 auto" }} />
                ) : null}
              </button>
            );
          })}

          {loadState === "loading" ? (
            <div
              role="none"
              style={{
                padding: "9px 10px",
                color: T.dim,
                font: `12px/1.45 ${T.sans}`,
              }}
            >
              <span role="status">{t("terminal.external.loading")}</span>
            </div>
          ) : loadState === "error" ? (
            <div
              role="none"
              style={{
                padding: "8px 8px 6px",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 8,
              }}
            >
              <span style={{ color: T.dim, font: `12px/1.45 ${T.sans}` }}>
                {t("terminal.external.discoveryFailed")}
              </span>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="shioriExternalTerminalMenuItem"
                onClick={() => void refreshTerminals()}
                style={{
                  border: `1px solid ${T.rule}`,
                  borderRadius: 6,
                  background: T.surface,
                  color: T.ink,
                  padding: "6px 9px",
                  cursor: "pointer",
                  font: `600 11.5px/1 ${T.sans}`,
                }}
              >
                {t("terminal.external.retry")}
              </button>
            </div>
          ) : terminals.length === 0 ? (
            <div
              role="none"
              style={{
                padding: "9px 10px",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 8,
                color: T.dim,
                font: `12px/1.45 ${T.sans}`,
              }}
            >
              <span role="status">{t("terminal.external.noneAvailable")}</span>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="shioriExternalTerminalMenuItem"
                onClick={() => void refreshTerminals()}
                style={{
                  border: `1px solid ${T.rule}`,
                  borderRadius: 6,
                  background: T.surface,
                  color: T.ink,
                  padding: "6px 9px",
                  cursor: "pointer",
                  font: `600 11.5px/1 ${T.sans}`,
                }}
              >
                {t("terminal.external.retry")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <span style={screenReaderOnlyStyle} aria-live="polite">
        {openingId
          ? t("terminal.external.opening", {
              name: terminals.find((terminal) => terminal.id === openingId)?.name ?? "",
            })
          : loadState === "loading"
            ? t("terminal.external.loading")
            : ""}
      </span>
    </div>
  );
}

function menuControls(root: HTMLDivElement | null): HTMLButtonElement[] {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
}

function splitButtonStyle(
  part: "primary" | "chooser",
  open: boolean,
): React.CSSProperties {
  const isPrimary = part === "primary";
  return {
    width: isPrimary ? 31 : 23,
    height: 28,
    boxSizing: "border-box",
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderStyle: "solid",
    borderColor: open ? T.accent : T.rule,
    borderWidth: isPrimary ? "1px 0 1px 1px" : 1,
    borderRadius: isPrimary ? "8px 0 0 8px" : "0 8px 8px 0",
    background: open ? T.accentGhost : T.surface,
    color: open ? T.accentText : T.dim,
    cursor: "pointer",
    transition:
      "background 120ms ease, border-color 120ms ease, color 120ms ease, transform 90ms ease, opacity 120ms ease",
  };
}

function ExternalTerminalIcon({
  terminal,
  subdued = false,
  size = 20,
}: {
  terminal: ExternalTerminalApp | null;
  subdued?: boolean;
  size?: number;
}) {
  const [failedIconDataUrl, setFailedIconDataUrl] = useState<string | null>(null);
  const iconDataUrl = terminal?.iconDataUrl ?? null;
  const showOfficialIcon = iconDataUrl !== null && failedIconDataUrl !== iconDataUrl;
  const fallbackSize = Math.max(13, size - 4);
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: subdued ? T.dim2 : "currentColor",
        opacity: subdued ? 0.58 : 1,
      }}
    >
      {showOfficialIcon ? (
        <img
          src={iconDataUrl}
          alt=""
          draggable={false}
          onError={() => setFailedIconDataUrl(iconDataUrl)}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            objectFit: "contain",
            borderRadius: 4,
          }}
        />
      ) : (
        <Ic.terminal style={{ width: fallbackSize, height: fallbackSize }} />
      )}
    </span>
  );
}

const screenReaderOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
