import { useEffect, useLayoutEffect, useRef } from "react";

type EscapeEntry = {
  token: symbol;
  close: () => void;
};

const escapeStack: EscapeEntry[] = [];

function onEscapeKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  top.close();
}

// Wires Escape to dismiss a dialog/panel. The listener runs in capture
// phase so the dialog handler wins before app-level shortcut listeners
// such as Canvas keydown.
export function useEscapeClose(enabled: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  const tokenRef = useRef(Symbol("escape-close"));
  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!enabled) return;
    const entry: EscapeEntry = {
      token: tokenRef.current,
      close: () => closeRef.current(),
    };
    escapeStack.push(entry);
    if (escapeStack.length === 1) {
      window.addEventListener("keydown", onEscapeKey, { capture: true });
    }
    return () => {
      const index = escapeStack.findIndex(
        (candidate) => candidate.token === entry.token,
      );
      if (index !== -1) escapeStack.splice(index, 1);
      if (escapeStack.length === 0) {
        window.removeEventListener("keydown", onEscapeKey, { capture: true });
      }
    };
  }, [enabled]);
}
