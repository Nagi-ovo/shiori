import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { safeUnlisten } from "../../platform/ipc";
import {
  WINDOW_CAPTION_HEIGHT,
  windowCaptionPorts,
  type WindowCaptionPorts,
} from "../../platform/windowCaption";

/**
 * Minimize / maximize / close for the undecorated Windows window. Pinned to
 * the top-right corner over every screen, the way macOS floats its traffic
 * lights top-left; each screen keeps WINDOW_CAPTION_WIDTH clear. Sits above
 * modal backdrops (z 40) so the window can still be closed with a dialog
 * open, as on macOS. Out of the tab order like native caption buttons;
 * keyboard users have Alt+F4 and Win+arrows.
 */
export function WindowCaption({
  ports = windowCaptionPorts,
}: {
  ports?: WindowCaptionPorts;
}) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let live = true;
    let off: (() => unknown) | null = null;
    const sync = () => {
      ports.isMaximized().then(
        (value) => {
          if (live) setMaximized(value);
        },
        () => undefined,
      );
    };
    sync();
    ports.onResized(sync).then(
      (dispose) => {
        if (live) off = dispose;
        else safeUnlisten(dispose);
      },
      () => undefined,
    );
    return () => {
      live = false;
      safeUnlisten(off);
    };
  }, [ports]);

  const run = (action: () => Promise<void>) => () => {
    void action().catch(() => undefined);
  };

  return (
    <div
      className="shioriPrintHide"
      // Dialogs leave this subtree out of their inert background: these are
      // the window's only caption buttons, and they sit above every backdrop.
      data-shiori-stays-live=""
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        zIndex: 45,
        display: "flex",
        height: WINDOW_CAPTION_HEIGHT,
      }}
    >
      <CaptionButton label={t("windowCaption.minimize")} onClick={run(ports.minimize)}>
        <path d="M0 5.5h10" />
      </CaptionButton>
      <CaptionButton
        label={t(maximized ? "windowCaption.restore" : "windowCaption.maximize")}
        onClick={run(ports.toggleMaximize)}
      >
        {maximized ? (
          <>
            <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
            <path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
          </>
        ) : (
          <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
        )}
      </CaptionButton>
      <CaptionButton label={t("common.close")} onClick={run(ports.close)} close>
        <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  label,
  onClick,
  close,
  children,
}: {
  label: string;
  onClick: () => void;
  close?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="shioriCaptionButton"
      data-close={close ? "" : undefined}
      aria-label={label}
      title={label}
      tabIndex={-1}
      onClick={onClick}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}
