import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { ExpandableColorPicker } from "./ExpandableColorPicker";
import {
  DRAW_TOOLS,
  RECT_COLORS,
  RECT_DEFAULT_COLOR,
  SIGN_TOOLS,
  TEXT_MARKUP_TOOLS,
  iconForDrawTool,
  iconForSignTool,
  iconForTextMarkupTool,
  type DrawToolId,
  type SignToolId,
  type TextMarkupToolId,
} from "./inspectorOptions";

// The inspector's small pickers: the mode switch for each shared toolbar
// slot, the rectangle fill, and the stamp kind.

export function DrawModePicker({
  value,
  onChange,
}: {
  value: DrawToolId;
  onChange: (value: DrawToolId) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t("inspector.fields.drawMode")}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      {DRAW_TOOLS.map((mode) => {
        const Icon = iconForDrawTool(mode);
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            title={t(`tools.${mode}`)}
            aria-pressed={active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(mode)}
            style={{
              width: 32,
              height: 32,
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid transparent",
              borderRadius: 6,
              background: active ? T.ink : "transparent",
              color: active ? T.cream : T.ink2,
              cursor: "pointer",
            }}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

export function SignModePicker({
  value,
  onChange,
}: {
  value: SignToolId;
  onChange: (value: SignToolId) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t("inspector.fields.signMode")}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      {SIGN_TOOLS.map((mode) => {
        const Icon = iconForSignTool(mode);
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            title={t(`tools.${mode}`)}
            aria-pressed={active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(mode)}
            style={{
              width: 32,
              height: 32,
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid transparent",
              borderRadius: 6,
              background: active ? T.ink : "transparent",
              color: active ? T.cream : T.ink2,
              cursor: "pointer",
            }}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

export function RectFillPicker({
  value,
  recent,
  onChange,
  onCommit,
}: {
  value: string | null;
  recent: string[];
  onChange: (value: string | null) => void;
  onCommit?: (value: string) => void;
}) {
  const { t } = useTranslation();
  const fillLabel = t("inspector.fields.fill");
  const noneLabel = t("inspector.fields.fillNone");
  const selected = value === null;

  return (
    <div
      aria-label={fillLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <button
        type="button"
        title={noneLabel}
        aria-label={noneLabel}
        onClick={() => onChange(null)}
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: T.surface,
          cursor: "pointer",
          border: `1.5px solid ${selected ? T.ink : T.rule}`,
          padding: 0,
          boxShadow: selected ? `0 0 0 2px ${T.paper}` : "none",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: -3,
            top: 9,
            width: 28,
            height: 2,
            background: T.ink,
            transform: "rotate(-45deg)",
            transformOrigin: "center",
          }}
        />
      </button>
      <ExpandableColorPicker
        options={RECT_COLORS}
        value={value ?? RECT_DEFAULT_COLOR}
        selectedValue={value}
        recent={recent}
        onChange={(c) => onChange(c)}
        onCommit={onCommit}
      />
    </div>
  );
}

export function MarkupModePicker({
  value,
  onChange,
}: {
  value: TextMarkupToolId;
  onChange: (value: TextMarkupToolId) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t("inspector.fields.markupMode")}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      {TEXT_MARKUP_TOOLS.map((mode) => {
        const Icon = iconForTextMarkupTool(mode);
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            title={t(`tools.${mode}`)}
            aria-pressed={active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(mode)}
            style={{
              width: 32,
              height: 32,
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid transparent",
              borderRadius: 6,
              background: active ? T.ink : "transparent",
              color: active ? T.cream : T.ink2,
              cursor: "pointer",
            }}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

export function StampKindPicker({
  value,
  onChange,
}: {
  value: "check" | "cross";
  onChange: (kind: "check" | "cross") => void;
}) {
  const options: Array<{ value: "check" | "cross"; label: string }> = [
    { value: "check", label: "✓" },
    { value: "cross", label: "✗" },
  ];
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0,
        border: `1px solid ${T.rule}`,
        borderRadius: 6,
        background: T.surface,
        overflow: "hidden",
      }}
    >
      {options.map((option, i) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            style={{
              width: 30,
              height: 28,
              border: "none",
              borderLeft: i === 0 ? "none" : `1px solid ${T.rule}`,
              background: active ? T.ink : "transparent",
              color: active ? T.cream : T.ink2,
              cursor: "pointer",
              font: `600 15px/1 ${T.sans}`,
              padding: 0,
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
