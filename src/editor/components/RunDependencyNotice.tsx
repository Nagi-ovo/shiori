import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isApprovableDependencyKind,
  remoteDependencyKey,
  type RemoteDependency,
  type RemoteDependencyKind,
} from "../../documents/runnableHtml";
import { T } from "../../design/tokens";
import { IS_TAURI } from "../../platform";

const REMOTE_DEPENDENCY_KIND_KEYS: Record<RemoteDependencyKind, string> = {
  script: "documents.runDepsKindScript",
  stylesheet: "documents.runDepsKindStylesheet",
  image: "documents.runDepsKindImage",
  media: "documents.runDepsKindMedia",
  frame: "documents.runDepsKindFrame",
  font: "documents.runDepsKindFont",
  connect: "documents.runDepsKindConnect",
  other: "documents.runDepsKindOther",
};

// Run frames are blob: documents, which inherit the CSP of the app page that
// made them; the frame's own meta policy can only narrow it. The Tauri app's
// CSP (src-tauri/tauri.conf.json) admits remote https: images and no remote
// script, style or media source, so approving those could never take effect.
// The web build serves no CSP of its own.
function canApprove(dependency: RemoteDependency, inheritsAppCsp: boolean) {
  if (!isApprovableDependencyKind(dependency.kind)) return false;
  return (
    !inheritsAppCsp ||
    (dependency.kind === "image" && dependency.url.startsWith("https:"))
  );
}

// Slim disclosure bar above the run frame: run mode is offline by design, so
// every remote dependency the document references is blocked — this explains
// the otherwise silent "Can't find variable: THREE"-class failures. Approvable
// kinds carry a checkbox; applying the selection rebuilds the frame with those
// origins added to the matching CSP directives only.
export function RunDependencyNotice({
  dependencies,
  appliedKeys,
  selectedKeys,
  selectionDirty,
  onToggle,
  onApply,
  inheritsAppCsp = IS_TAURI,
}: {
  dependencies: RemoteDependency[];
  appliedKeys: ReadonlySet<string>;
  selectedKeys: ReadonlySet<string>;
  selectionDirty: boolean;
  onToggle: (dependencyKey: string) => void;
  onApply: () => void;
  inheritsAppCsp?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const blockedCount = dependencies.filter(
    (dependency) => !appliedKeys.has(remoteDependencyKey(dependency)),
  ).length;
  const hasApprovable = dependencies.some((dependency) =>
    canApprove(dependency, inheritsAppCsp),
  );
  const appBlocksSome = dependencies.some(
    (dependency) =>
      isApprovableDependencyKind(dependency.kind) &&
      !canApprove(dependency, inheritsAppCsp),
  );
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "6px 12px",
        background: T.cream,
        borderBottom: `1px solid ${T.rule}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            minWidth: 0,
            flex: 1,
            color: T.ink2,
            font: `500 12px/1.35 ${T.sans}`,
          }}
        >
          {blockedCount > 0
            ? t("documents.runDepsBlocked", { count: blockedCount })
            : t("documents.runDepsAllowed", {
                count: dependencies.length - blockedCount,
              })}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          style={{
            flex: "0 0 auto",
            height: 26,
            padding: "0 9px",
            borderRadius: 6,
            border: `1px solid ${T.rule}`,
            background: T.surface,
            color: T.ink2,
            font: `500 12px/1 ${T.sans}`,
            cursor: "pointer",
          }}
        >
          {expanded ? t("documents.runDepsHide") : t("documents.runDepsShow")}
        </button>
      </div>
      {expanded ? (
        <>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: "2px 0 0",
              maxHeight: 168,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {dependencies.map((dependency) => {
              const dependencyKey = remoteDependencyKey(dependency);
              const approvable = canApprove(dependency, inheritsAppCsp);
              const details = (
                <>
                  <span
                    style={{
                      flex: "0 0 auto",
                      color: T.dim,
                      font: `600 10px/1.6 ${T.mono}`,
                      letterSpacing: 0.4,
                      textTransform: "uppercase",
                    }}
                  >
                    {t(REMOTE_DEPENDENCY_KIND_KEYS[dependency.kind])}
                  </span>
                  <span
                    style={{
                      flex: "0 0 auto",
                      color: T.ink2,
                      font: `600 12px/1.4 ${T.sans}`,
                    }}
                  >
                    {dependency.origin}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      color: T.dim,
                      font: `500 11px/1.4 ${T.mono}`,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {dependency.url}
                  </span>
                </>
              );
              return (
                <li key={dependencyKey} style={{ minWidth: 0 }}>
                  {approvable ? (
                    <label
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                        minWidth: 0,
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(dependencyKey)}
                        onChange={() => onToggle(dependencyKey)}
                        style={{
                          flex: "0 0 auto",
                          margin: 0,
                          accentColor: T.accent,
                          transform: "translateY(2px)",
                        }}
                      />
                      {details}
                    </label>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                        minWidth: 0,
                        // Keep text columns aligned with checkbox rows.
                        paddingLeft: 21,
                      }}
                    >
                      {details}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {appBlocksSome ? (
            <span style={{ color: T.dim, font: `500 11px/1.4 ${T.sans}` }}>
              {t("documents.runDepsAppImagesOnly")}
            </span>
          ) : null}
          {hasApprovable ? (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                padding: "2px 0 4px",
              }}
            >
              <button
                type="button"
                onClick={onApply}
                disabled={!selectionDirty}
                style={{
                  flex: "0 0 auto",
                  height: 26,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: `1px solid ${selectionDirty ? T.accent : T.rule}`,
                  background: selectionDirty ? T.accent : T.surface,
                  color: selectionDirty ? T.onAccent : T.dim,
                  font: `600 12px/1 ${T.sans}`,
                  cursor: selectionDirty ? "pointer" : "default",
                }}
              >
                {t("documents.runDepsAllowSelected")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
