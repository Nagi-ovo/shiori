import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";
import { T } from "../../design/tokens";
import {
  deleteSignature,
  listSignatures,
  normalizeInkSignature,
  saveSignature,
  subscribeSignatures,
  type SavedImageSignature,
  type SavedInkSignature,
  type SavedSignature,
} from "../../storage/signatures";
import type { PdfPoint } from "../../pdf/model/types";
import { Ic } from "./icons";
import { IconBtn, Modal } from "./ui";

const PAD_W = 420;
const PAD_H = 160;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const ERROR_COLOR = "#b13a2e";

type Props = {
  activeSignatureId?: string;
  onClose: () => void;
  onUse: (signature: SavedSignature) => void;
  onDeleted: (id: string) => void;
};

export function SignatureDialog({
  activeSignatureId,
  onClose,
  onUse,
  onDeleted,
}: Props) {
  const { t } = useTranslation();
  const [signatures, setSignatures] = useState<SavedSignature[]>([]);
  const [paths, setPaths] = useState<PdfPoint[][]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const drawingRef = useRef(false);

  const defaultName = useMemo(
    () => t("signatures.defaultName", { count: signatures.length + 1 }),
    [signatures.length, t],
  );

  useEffect(() => {
    let alive = true;
    const load = () => {
      void listSignatures()
        .then((items) => {
          if (alive) setSignatures(items);
        })
        .catch(() => {
          if (alive) setError(t("signatures.errors.storage"));
        });
    };
    load();
    const unsubscribe = subscribeSignatures(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [t]);

  const pointFromEvent = (event: PointerEvent<SVGSVGElement>): PdfPoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * PAD_W,
      y: ((event.clientY - rect.top) / rect.height) * PAD_H,
    };
  };

  const beginDraw = (event: PointerEvent<SVGSVGElement>) => {
    event.preventDefault();
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPaths((current) => [...current, [pointFromEvent(event)]]);
  };

  const continueDraw = (event: PointerEvent<SVGSVGElement>) => {
    if (!drawingRef.current) return;
    const point = pointFromEvent(event);
    setPaths((current) => {
      const next = current.slice();
      const last = next[next.length - 1];
      if (!last) return current;
      next[next.length - 1] = [...last, point];
      return next;
    });
  };

  const finishDraw = () => {
    drawingRef.current = false;
  };

  const saveInk = async () => {
    const signature = normalizeInkSignature({
      id: nanoid(),
      name: name.trim() || defaultName,
      paths,
      width: PAD_W,
      height: PAD_H,
      color: "#1a1815",
      lineWidth: 3,
    });
    if (signature.paths.length === 0) return;
    try {
      await saveSignature(signature);
      setPaths([]);
      setName("");
      setError(null);
    } catch {
      setError(t("signatures.errors.storage"));
    }
  };

  const importImage = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      setError(t("signatures.errors.tooLarge"));
      return;
    }
    const mimeType =
      file.type === "image/png"
        ? "image/png"
        : file.type === "image/jpeg"
          ? "image/jpeg"
          : null;
    if (!mimeType) {
      setError(t("signatures.errors.unsupported"));
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const size = await imageSizeFromDataUrl(dataUrl);
      const now = Date.now();
      const signature: SavedImageSignature = {
        kind: "image",
        id: nanoid(),
        name: file.name.replace(/\.(png|jpe?g)$/i, "") || defaultName,
        dataUrl,
        mimeType,
        width: size.width,
        height: size.height,
        aspectRatio: size.width / Math.max(1, size.height),
        createdAt: now,
        updatedAt: now,
      };
      await saveSignature(signature);
      setError(null);
    } catch {
      setError(t("signatures.errors.storage"));
    }
  };

  const removeSignature = async (id: string) => {
    try {
      await deleteSignature(id);
      onDeleted(id);
      setError(null);
    } catch {
      setError(t("signatures.errors.storage"));
    }
  };

  return (
    <Modal
      title={t("signatures.title")}
      subtitle={t("signatures.subtitle")}
      onClose={onClose}
      width={680}
    >
      <div style={{ display: "grid", gap: 16 }}>
        <section style={{ display: "grid", gap: 10 }}>
          <div
            style={{
              display: "flex",
              // Align the import button with the name input, not the
              // vertical center of the label+input block (which floated
              // the button up above the field).
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <label
              style={{
                display: "grid",
                gap: 5,
                flex: "1 1 auto",
                minWidth: 0,
                font: `600 12px/1 ${T.sans}`,
                color: T.ink2,
              }}
            >
              {t("signatures.name")}
              <input
                value={name}
                placeholder={defaultName}
                onChange={(event) => setName(event.currentTarget.value)}
                style={{
                  width: "100%",
                  height: 32,
                  border: `1px solid ${T.rule}`,
                  borderRadius: 6,
                  padding: "0 10px",
                  background: T.surface,
                  color: T.ink,
                  outline: "none",
                  font: `500 13px/1 ${T.sans}`,
                }}
              />
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void importImage(file);
              }}
            />
            <IconBtn
              tone="outline"
              title={t("signatures.import")}
              onClick={() => fileInputRef.current?.click()}
            >
              <Ic.plus />
              <span>{t("signatures.import")}</span>
            </IconBtn>
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${PAD_W} ${PAD_H}`}
            onPointerDown={beginDraw}
            onPointerMove={continueDraw}
            onPointerUp={finishDraw}
            onPointerCancel={finishDraw}
            style={{
              width: "100%",
              aspectRatio: `${PAD_W} / ${PAD_H}`,
              border: `1px solid ${T.rule}`,
              borderRadius: 6,
              background: T.surface,
              touchAction: "none",
              display: "block",
            }}
          >
            {/* A faint signing line turns the empty pad from a blank void
                into a "sign here" affordance; it vanishes on first stroke. */}
            {paths.length === 0 ? (
              <line
                x1={44}
                y1={PAD_H * 0.72}
                x2={PAD_W - 44}
                y2={PAD_H * 0.72}
                stroke={T.rule}
                strokeWidth={1}
                strokeLinecap="round"
              />
            ) : null}
            {paths.map((path, index) => (
              <path
                key={index}
                d={path
                  .map((point, i) => `${i === 0 ? "M" : "L"}${point.x},${point.y}`)
                  .join(" ")}
                fill="none"
                stroke="#1a1815"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        </section>

        {error ? (
          <div
            role="alert"
            style={{
              border: `1px solid ${ERROR_COLOR}`,
              color: ERROR_COLOR,
              background: T.surface,
              borderRadius: 6,
              padding: "8px 10px",
              font: `600 12px/1.35 ${T.sans}`,
            }}
          >
            {error}
          </div>
        ) : null}

        <section style={{ display: "grid", gap: 8 }}>
          {/* Header row: the "saved" label on the left balances the clear /
              save actions on the right, so the bottom no longer alternates
              lonely content from one side to the other. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              minHeight: 32,
            }}
          >
            <div style={{ font: `600 12px/1 ${T.sans}`, color: T.dim }}>
              {t("signatures.saved")}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <IconBtn
                tone="outline"
                title={t("signatures.clear")}
                disabled={paths.length === 0}
                onClick={() => setPaths([])}
              >
                {t("signatures.clear")}
              </IconBtn>
              <IconBtn
                tone="primary"
                title={t("signatures.save")}
                disabled={paths.length === 0}
                onClick={() => void saveInk()}
              >
                <Ic.check />
                <span>{t("signatures.save")}</span>
              </IconBtn>
            </div>
          </div>
          {signatures.length === 0 ? (
            <div style={{ color: T.dim2, font: `500 13px/1.4 ${T.sans}` }}>
              {t("signatures.empty")}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {signatures.map((signature) => (
                <SignatureRow
                  key={signature.id}
                  signature={signature}
                  active={signature.id === activeSignatureId}
                  onUse={() => {
                    onUse(signature);
                    onClose();
                  }}
                  onDelete={() => void removeSignature(signature.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function SignatureRow({
  signature,
  active,
  onUse,
  onDelete,
}: {
  signature: SavedSignature;
  active: boolean;
  onUse: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px minmax(0, 1fr) auto auto",
        gap: 10,
        alignItems: "center",
        border: `1px solid ${active ? T.ink : T.rule}`,
        borderRadius: 6,
        padding: 8,
        background: active ? T.tint : T.surface,
      }}
    >
      <SignaturePreview signature={signature} />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: T.ink,
            font: `600 13px/1.2 ${T.sans}`,
          }}
        >
          {signature.name}
        </div>
        <div style={{ color: T.dim, font: `500 11px/1.4 ${T.mono}` }}>
          {t(`signatures.kinds.${signature.kind}`)}
        </div>
      </div>
      <IconBtn tone={active ? "primary" : "outline"} title={t("signatures.use")} onClick={onUse}>
        <Ic.check />
        <span>{t("signatures.use")}</span>
      </IconBtn>
      <IconBtn title={t("storage.delete")} onClick={onDelete}>
        <Ic.trash />
      </IconBtn>
    </div>
  );
}

function SignaturePreview({ signature }: { signature: SavedSignature }) {
  if (signature.kind === "image") {
    return (
      <img
        src={signature.dataUrl}
        alt=""
        style={{
          width: 120,
          height: 46,
          objectFit: "contain",
          background: "#fff",
          border: `1px solid ${T.ruleSoft}`,
          borderRadius: 4,
          display: "block",
        }}
      />
    );
  }
  return <InkSignaturePreview signature={signature} />;
}

function InkSignaturePreview({ signature }: { signature: SavedInkSignature }) {
  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="xMidYMid meet"
      style={{
        width: 120,
        height: 46,
        background: "#fff",
        border: `1px solid ${T.ruleSoft}`,
        borderRadius: 4,
        display: "block",
      }}
    >
      {signature.paths.map((path, index) => (
        <path
          key={index}
          d={path.map((point, i) => `${i === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ")}
          fill="none"
          stroke={signature.color}
          strokeWidth={signature.lineWidthRatio}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function imageSizeFromDataUrl(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = dataUrl;
  });
}
