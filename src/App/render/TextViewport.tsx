import { useTranslation } from "react-i18next";
import { resolveReadableColor } from "../../design/color";
import { paletteForTheme, type EffectiveTheme } from "../../design/theme";
import { T } from "../../design/tokens";
import {
  pushRecentMarkdownFont,
  resolveMarkdownAppearance,
} from "../../documents/markdownAppearance";
import { DocumentViewer } from "../../editor/components/DocumentViewer";
import { MarkdownAppearancePicker } from "../../editor/components/MarkdownAppearancePicker";
import { ZoomControls } from "../../editor/components/ZoomControls";
import { useAppStore, type PrefsTheme } from "../../editor/store/store";
import { readLocalDocumentImage } from "../../platform";
import type { WorkspaceTextViewMode } from "../../storage/workspace";
import {
  patchTabTextView,
  setTabTextScrollTop,
  setTabTextZoom,
} from "../../workspace/appWorkspace";
import type { TextSources } from "../../workspace/textSources/textSources";
import type { WorkspaceRuntimeTab } from "../../workspace/types";
import { DocumentLoadingState } from "./DocumentLoadingState";

/**
 * A Markdown or HTML tab's viewport: the document with its toolbar (save to
 * file, appearance, zoom) once loaded, its loading state before.
 */
export function TextViewport({
  tab,
  effectiveTheme,
  prefsTheme,
  textSources,
  onRetry,
}: {
  tab: WorkspaceRuntimeTab;
  effectiveTheme: EffectiveTheme;
  prefsTheme: PrefsTheme;
  textSources: Pick<TextSources, "edit" | "saveToSource">;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const remoteImagePolicy = useAppStore((s) => s.prefs.remoteImagePolicy);
  const globalAppearance = useAppStore((s) => s.prefs.markdownAppearance);
  const recentFonts = useAppStore((s) => s.prefs.recentMarkdownFonts);
  const setPrefs = useAppStore((s) => s.setPrefs);

  if (tab.status !== "loaded" || tab.text == null) {
    return <DocumentLoadingState tab={tab} onRetry={onRetry} />;
  }
  const textKind = tab.kind === "html" ? "html" : "markdown";
  const zoom = tab.textView?.zoom ?? 1;
  const markdownMode: WorkspaceTextViewMode =
    textKind === "markdown" ? (tab.textView?.mode ?? "preview") : "preview";
  const appearanceOverride = tab.textView?.appearance;
  const appearance = resolveMarkdownAppearance(
    globalAppearance,
    appearanceOverride,
  );
  const palette = paletteForTheme(prefsTheme, effectiveTheme);
  const headingColor = resolveReadableColor(
    appearance.headingColor ?? palette.ink,
    palette.paper,
    palette.ink,
  );
  const setZoom = (next: number) => setTabTextZoom(tab.id, next);
  const setMarkdownMode = (mode: WorkspaceTextViewMode) =>
    patchTabTextView(
      tab.id,
      { mode },
      (current) =>
        current.kind !== "markdown" ||
        (current.textView?.mode ?? "preview") === mode,
    );

  return (
    <DocumentViewer
      key={tab.id}
      kind={textKind}
      title={tab.title}
      text={tab.text}
      documentId={tab.id}
      sourcePath={tab.source.type === "path" ? tab.source.path : undefined}
      remoteImagePolicy={remoteImagePolicy}
      readLocalImage={readLocalDocumentImage}
      scrollTop={tab.textView?.scrollTop ?? 0}
      zoom={zoom}
      onZoomChange={setZoom}
      markdownMode={markdownMode}
      markdownAppearance={appearance}
      markdownHeadingColor={headingColor.color}
      onMarkdownModeChange={textKind === "markdown" ? setMarkdownMode : undefined}
      onMarkdownTextChange={
        textKind === "markdown"
          ? (nextText) => textSources.edit(tab.id, nextText)
          : undefined
      }
      toolbar={
        <>
          {tab.textDirty === true ? (
            <button
              type="button"
              title={t("documents.saveToFileHint")}
              aria-label={t("documents.saveToFileHint")}
              onClick={() => {
                void textSources.saveToSource(tab.id);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 28,
                padding: "0 10px",
                font: `600 12.5px/1 ${T.sans}`,
                color: T.accent,
                background: T.surface,
                border: `1px solid ${T.accent}`,
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: T.accent,
                }}
              />
              {t("documents.saveToFile")}
            </button>
          ) : null}
          {textKind === "markdown" ? (
            <MarkdownAppearancePicker
              appearance={appearance}
              override={appearanceOverride}
              globalAppearance={globalAppearance}
              themePalette={palette}
              recentFonts={recentFonts}
              onOverrideChange={(override) =>
                patchTabTextView(
                  tab.id,
                  { appearance: override },
                  (current) => current.kind !== "markdown",
                )
              }
              onSetGlobalAppearance={(nextAppearance) =>
                setPrefs({ markdownAppearance: nextAppearance })
              }
              onUseFont={(font) =>
                setPrefs({
                  recentMarkdownFonts: pushRecentMarkdownFont(
                    useAppStore.getState().prefs.recentMarkdownFonts,
                    font,
                  ),
                })
              }
            />
          ) : null}
          <ZoomControls
            scale={zoom}
            setScale={setZoom}
            zoomOutLabel={t("tooltips.zoomOut")}
            zoomInLabel={t("tooltips.zoomIn")}
            zoomLevelLabel={t("tooltips.zoomLevel")}
          />
        </>
      }
      onScrollTopChange={(scrollTop) => setTabTextScrollTop(tab.id, scrollTop)}
    />
  );
}
