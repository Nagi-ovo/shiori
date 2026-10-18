import { useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { IconBtn, Modal } from "./ui";

type Props = {
  fileName: string;
  wrongPassword?: boolean;
  onSubmit: (password: string) => void;
  onClose: () => void;
};

export function PasswordDialog({
  fileName,
  wrongPassword,
  onSubmit,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");

  const submit = () => {
    if (!value) return;
    onSubmit(value);
  };

  return (
    <Modal
      onClose={onClose}
      title={t("password.title")}
      subtitle={fileName}
      width={380}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 14,
            color: T.dim,
            font: `13px/1.5 ${T.sans}`,
          }}
        >
          <Ic.lock />
          <span>{t("password.hint")}</span>
        </div>
        <input
          autoFocus
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={t("password.input")}
          placeholder={t("password.placeholder")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            height: 40,
            padding: "0 12px",
            borderRadius: 4,
            border: `1px solid ${wrongPassword ? T.rect : T.rule}`,
            background: T.surface,
            color: T.ink,
            font: `500 15px/1 ${T.sans}`,
          }}
        />
        {wrongPassword ? (
          <div
            style={{
              marginTop: 6,
              font: `12px/1.4 ${T.sans}`,
              color: T.rect,
            }}
          >
            {t("password.wrong")}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 18,
          }}
        >
          <IconBtn tone="outline" onClick={onClose}>
            {t("password.cancel")}
          </IconBtn>
          <IconBtn tone="primary" onClick={submit} disabled={!value}>
            {t("password.unlock")}
          </IconBtn>
        </div>
      </form>
    </Modal>
  );
}
