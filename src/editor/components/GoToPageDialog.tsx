import { useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { useEditorStore } from "../store/store";
import { IconBtn, Modal } from "./ui";

type Props = {
  onClose: () => void;
};

export function GoToPageDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const pages = useEditorStore((s) => s.model.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const goToPage = useEditorStore((s) => s.goToPage);
  const activeIndex = Math.max(
    0,
    pages.findIndex((p) => p.id === activePageId),
  );
  const [value, setValue] = useState(String(activeIndex + 1));
  const pageCount = pages.length;
  const pageNumber = Number(value);
  const valid =
    Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount;

  const submit = () => {
    if (!valid) return;
    const page = pages[pageNumber - 1];
    if (page) goToPage(page.id, pageNumber - 1);
    onClose();
  };

  return (
    <Modal
      onClose={onClose}
      title={t("goto.title")}
      subtitle={t("goto.subtitle", { count: pageCount })}
      width={360}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          autoFocus
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
          aria-label={t("goto.input")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            height: 40,
            padding: "0 12px",
            borderRadius: 4,
            border: `1px solid ${valid ? T.rule : T.rect}`,
            background: T.surface,
            color: T.ink,
            font: `500 15px/1 ${T.mono}`,
          }}
        />
        <div
          style={{
            marginTop: 8,
            minHeight: 18,
            font: `12px/1.4 ${T.sans}`,
            color: valid ? T.dim : T.rect,
          }}
        >
          {valid ? t("goto.hint") : t("goto.invalid", { count: pageCount })}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 18,
          }}
        >
          <IconBtn tone="outline" onClick={onClose}>
            {t("goto.cancel")}
          </IconBtn>
          <IconBtn tone="primary" onClick={submit} disabled={!valid}>
            {t("goto.action")}
          </IconBtn>
        </div>
      </form>
    </Modal>
  );
}
