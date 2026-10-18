import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  contrastingTextColor,
  normalizeHexColor,
  THEME_COLOR_SWATCHES,
} from "../../design/color";
import { T } from "../../design/tokens";
import { Ic } from "./icons";

type Props = {
  label: string;
  /** undefined means another scope (for example the global value) is active. */
  value: string | null | undefined;
  resolvedColor: string;
  adjusted?: boolean;
  automaticLabel: string;
  automaticColor?: string;
  customLabel: string;
  applyLabel?: string;
  invalidLabel: string;
  effectiveLabel?: string;
  adjustedLabel?: string;
  swatches?: readonly string[];
  /** Commit valid picker and HEX input without a separate Apply action. */
  immediate?: boolean;
  /** Some derived document colors still need to explain their safe fallback. */
  showResolvedColor?: boolean;
  onChange: (value: string | null) => void;
};

export function ThemeColorControl({
  label,
  value,
  resolvedColor,
  adjusted = false,
  automaticLabel,
  automaticColor,
  customLabel,
  applyLabel,
  invalidLabel,
  effectiveLabel,
  adjustedLabel,
  swatches = THEME_COLOR_SWATCHES,
  immediate = false,
  showResolvedColor = true,
  onChange,
}: Props) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const nativeColorInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(() => displayHex(value ?? resolvedColor));
  const [invalid, setInvalid] = useState(false);

  // React's synthetic `onChange` for input[type=color] also fires for every
  // native `input` preview. Listen to the DOM `change` event directly so a
  // colour-panel drag stays a cheap visual preview and only the finalized
  // selection is persisted.
  useEffect(() => {
    if (immediate) return;
    const input = nativeColorInputRef.current;
    if (!input) return;
    const commitNativeColor = () => {
      const color = input.value.toLowerCase();
      setDraft(color);
      setInvalid(false);
      onChange(color);
    };
    input.addEventListener("change", commitNativeColor);
    return () => input.removeEventListener("change", commitNativeColor);
  }, [immediate, onChange]);

  const applyDraft = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeHexColor(draft);
    if (!normalized) {
      setInvalid(true);
      return;
    }
    setDraft(normalized.toUpperCase());
    setInvalid(false);
    onChange(normalized);
  };

  return (
    <div role="group" aria-label={label}>
      <button
        type="button"
        className="shioriAppearanceHover"
        aria-pressed={value === null}
        onClick={() => {
          setDraft(displayHex(automaticColor ?? resolvedColor));
          setInvalid(false);
          onChange(null);
        }}
        style={optionButtonStyle(value === null)}
      >
        <span style={optionCheckStyle(value === null)}>
          <Ic.check aria-hidden />
        </span>
        <span>{automaticLabel}</span>
      </button>

      <div
        role="group"
        aria-label={label}
        style={{
          marginTop: 10,
          display: "grid",
          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
          gap: 7,
        }}
      >
        {swatches.map((color) => {
          const selected = value === color;
          return (
            <button
              key={color}
              type="button"
              aria-label={color.toUpperCase()}
              aria-pressed={selected}
              title={color.toUpperCase()}
              onClick={() => {
                setDraft(displayHex(color));
                setInvalid(false);
                onChange(color);
              }}
              style={{
                aspectRatio: "1",
                minWidth: 0,
                padding: 0,
                display: "grid",
                placeItems: "center",
                border: `1px solid ${selected ? T.ink : T.rule}`,
                borderRadius: 7,
                background: color,
                color: contrastingTextColor(color),
                cursor: "pointer",
                boxShadow: selected ? `0 0 0 2px ${T.surface}, 0 0 0 3px ${T.ink}` : "none",
                transition: "transform 90ms ease, box-shadow 120ms ease",
              }}
            >
              {selected ? <Ic.check aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      <form
        onSubmit={applyDraft}
        style={{
          marginTop: 13,
          paddingTop: 12,
          borderTop: `1px solid ${T.ruleSoft}`,
        }}
      >
        <label
          htmlFor={inputId}
          style={{
            display: "block",
            marginBottom: 6,
            color: T.dim,
            font: `600 11px/1.2 ${T.sans}`,
          }}
        >
          {customLabel}
        </label>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: immediate ? "32px minmax(0, 1fr)" : "32px minmax(0, 1fr) auto",
            gap: 6,
          }}
        >
          <input
            ref={nativeColorInputRef}
            type="color"
            aria-label={customLabel}
            value={normalizeHexColor(draft) ?? resolvedColor}
            onInput={(event) => {
              const color = event.currentTarget.value.toLowerCase();
              setDraft(color.toUpperCase());
              setInvalid(false);
              if (immediate) onChange(color);
            }}
            style={{
              width: 32,
              height: 32,
              boxSizing: "border-box",
              padding: 2,
              border: `1px solid ${T.rule}`,
              borderRadius: 6,
              background: T.paper,
              cursor: "pointer",
            }}
          />
          <input
            id={inputId}
            value={draft}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            spellCheck={false}
            autoCapitalize="none"
            placeholder="#3388bb"
            onChange={(event) => {
              const nextDraft = event.currentTarget.value.toUpperCase();
              setDraft(nextDraft);
              setInvalid(false);
              const normalized = normalizeHexColor(nextDraft);
              if (immediate && normalized && nextDraft.trim().length === 7) {
                onChange(normalized);
              }
            }}
            onBlur={() => {
              if (!immediate) return;
              const normalized = normalizeHexColor(draft);
              if (!normalized) {
                setInvalid(draft.trim().length > 0);
                return;
              }
              setDraft(normalized.toUpperCase());
              setInvalid(false);
              onChange(normalized);
            }}
            style={{
              minWidth: 0,
              height: 32,
              boxSizing: "border-box",
              padding: "0 9px",
              border: `1px solid ${invalid ? T.rect : T.rule}`,
              borderRadius: 6,
              background: T.paper,
              color: T.ink,
              font: `500 12px/1 ${T.mono}`,
            }}
          />
          {!immediate && applyLabel ? (
            <button
              type="submit"
              style={{
                height: 32,
                padding: "0 10px",
                border: `1px solid ${T.rule}`,
                borderRadius: 6,
                background: T.surface,
                color: T.ink2,
                cursor: "pointer",
                font: `600 11.5px/1 ${T.sans}`,
              }}
            >
              {applyLabel}
            </button>
          ) : null}
        </div>
        {invalid ? (
          <div
            id={errorId}
            role="alert"
            style={{ marginTop: 6, color: T.rect, font: `500 11px/1.35 ${T.sans}` }}
          >
            {invalidLabel}
          </div>
        ) : null}
      </form>

      {showResolvedColor && effectiveLabel ? (
        <div
          style={{
            marginTop: 12,
            padding: "9px 10px",
            display: "flex",
            alignItems: "center",
            gap: 9,
            borderRadius: 7,
            background: T.cream,
            color: T.dim,
            font: `500 11.5px/1.4 ${T.sans}`,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 18,
              height: 18,
              flex: "0 0 18px",
              border: `1px solid ${T.rule}`,
              borderRadius: 5,
              background: resolvedColor,
            }}
          />
          <span>
            {effectiveLabel}
            {adjusted && adjustedLabel ? ` · ${adjustedLabel}` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function displayHex(value: string): string {
  return (normalizeHexColor(value) ?? value).toUpperCase();
}

function optionButtonStyle(selected: boolean): CSSProperties {
  return {
    width: "100%",
    minHeight: 36,
    padding: "7px 9px",
    display: "flex",
    alignItems: "center",
    gap: 9,
    border: "none",
    borderRadius: 7,
    background: selected ? T.accentGhost : "transparent",
    color: selected ? T.accentText : T.ink,
    cursor: "pointer",
    textAlign: "left",
    font: `600 12px/1.25 ${T.sans}`,
  };
}

function optionCheckStyle(selected: boolean): CSSProperties {
  return {
    width: 17,
    flex: "0 0 17px",
    display: "inline-flex",
    color: selected ? T.accent : "transparent",
  };
}
