import type { ReactNode } from "react";
import {
  DOWNLOAD_LABEL_KEYS,
  DOWNLOAD_TARGETS,
  recommendDownloadFor,
  type DownloadKey,
} from "../downloads";
import { useLang } from "../i18n/context";
import type { Dict } from "../i18n/dict";
import { usePlatform } from "../platform";
import {
  useDownloads,
  useRelease,
  type ReleaseInfo,
  type ReleasePlatform,
} from "../release/context";

function formatSize(bytes: number): string {
  // Marketing-style display: 14_900_000 → "14.9 MB". Decimal megabytes
  // (matches every other download page on the web; binary "MiB" would
  // confuse non-technical users).
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function metaFor(
  releaseKey: ReleasePlatform | undefined,
  ext: string,
  release: ReleaseInfo | null,
): string {
  if (!releaseKey) {
    return ext;
  }
  const info = release?.platforms?.[releaseKey];
  if (!info) {
    return ext;
  }
  return `${formatSize(info.size)} · ${ext}`;
}

const ICONS: Record<DownloadKey, ReactNode> = {
  macSilicon: <AppleGlyph />,
  macIntel: <AppleGlyph />,
  windows: <WindowsGlyph />,
  linuxAppImage: <LinuxGlyph />,
  linuxDeb: <LinuxGlyph />,
  androidPlay: <AndroidGlyph />,
  androidApk: <AndroidGlyph />,
  ios: <AppleGlyph />,
};

export function Download() {
  const { t } = useLang();
  const platform = usePlatform();
  const recommended = recommendDownloadFor(platform);
  const release = useRelease();
  const downloads = useDownloads();

  return (
    <section className="section section-cta" id="download">
      <div className="wrap">
        <div className="cta">
          <div className="cta-copy">
            <h2>
              <span>{t.ctaTitle}</span>
              {t.ctaKana && (
                <span className="jp">
                  {t.ctaKana.map((line, i) => (
                    <span key={i}>
                      {line}
                      {i < t.ctaKana!.length - 1 && <br />}
                    </span>
                  ))}
                </span>
              )}
            </h2>
            <p>{t.ctaBody}</p>
            <div className="checks cta-checks">
              <span>{t.ctaC1}</span>
              <span>{t.ctaC2}</span>
              <span>{t.ctaC3}</span>
            </div>
          </div>
          <div className="dl-card">
            {DOWNLOAD_TARGETS.map((row) => (
              <DlRow
                key={row.key}
                t={t}
                glyph={ICONS[row.key]}
                label={t[DOWNLOAD_LABEL_KEYS[row.key]] as string}
                meta={
                  row.kind === "store" || row.kind === "comingSoon"
                    ? row.ext
                    : metaFor(row.releaseKey, row.ext, release)
                }
                href={row.href}
                kind={row.kind}
                recommended={recommended === row.key}
              />
            ))}
            {downloads && downloads.total > 0 && (
              <p className="dl-total">
                {t.dlTotal.replace(
                  "{n}",
                  downloads.total.toLocaleString("en-US"),
                )}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

type DlRowProps = {
  t: Dict;
  glyph: ReactNode;
  label: string;
  meta: string;
  href?: string;
  kind: "download" | "store" | "comingSoon";
  recommended?: boolean;
};

function DlRow({
  t,
  glyph,
  label,
  meta,
  href,
  kind,
  recommended,
}: DlRowProps) {
  const ctaClass = recommended ? "btn-mini primary" : "btn-mini";
  const ctaLabel =
    kind === "download" ? (
      <>
        <span>{t.dlDownload}</span> ↓
      </>
    ) : kind === "comingSoon" ? (
      t.dlComingSoon
    ) : (
      t.dlOpen
    );
  return (
    <div className={recommended ? "dl-row dl-row-rec" : "dl-row"}>
      <span className="platform">
        <span className="icn" aria-hidden>
          {glyph}
        </span>
        <span>{label}</span>
        {recommended && (
          <span className="dl-badge" title={t.dlForYourMac}>
            <span className="dl-badge-dot" aria-hidden />
            {t.dlRecommended}
          </span>
        )}
      </span>
      <span className="meta">{meta}</span>
      {href ? (
        <a
          className={ctaClass}
          href={href}
          {...(kind === "download" ? { download: "" } : {})}
        >
          {ctaLabel}
        </a>
      ) : (
        <span className={`${ctaClass} disabled`} aria-disabled="true">
          {ctaLabel}
        </span>
      )}
    </div>
  );
}

function AppleGlyph() {
  return (
    <svg width="11" height="13" viewBox="0 0 24 28" fill="currentColor" aria-hidden>
      <path d="M19.4 14.9c0-3.5 2.9-5.2 3-5.3-1.6-2.4-4.2-2.7-5.1-2.7-2.2-.2-4.2 1.3-5.3 1.3-1.1 0-2.8-1.3-4.6-1.2-2.4 0-4.6 1.4-5.8 3.5-2.5 4.3-.6 10.6 1.8 14 1.2 1.7 2.5 3.5 4.3 3.5 1.7-.1 2.4-1.1 4.5-1.1s2.7 1.1 4.6 1.1c1.9 0 3.1-1.7 4.2-3.4 1.3-2 1.9-3.9 1.9-4 0 0-3.6-1.4-3.5-5.7zM15.9 4.6c.9-1.1 1.6-2.7 1.4-4.3-1.4.1-3 .9-4 2-.9 1-1.7 2.6-1.5 4.2 1.6.1 3.2-.8 4.1-1.9z" />
    </svg>
  );
}

function WindowsGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M0 3.6 9.7 2.3v9.4H0V3.6zM10.9 2.1 24 0v11.7H10.9V2.1zM0 13H9.7v9.4L0 21V13zm10.9 0H24v11.6L10.9 23V13z" />
    </svg>
  );
}

function LinuxGlyph() {
  return (
    <svg width="11" height="13" viewBox="0 0 24 28" fill="currentColor" aria-hidden>
      <path d="M12 0c-3 0-4.6 2.7-4.6 5.6 0 1.6.4 3 1 4.3-1.7 2-3.4 4.5-4 7.4-.4 2 .2 3.7 1.5 4.5 1.4.7 2.6.4 3.5 1.4.7.7 1.6 1.4 2.6 1.4s1.9-.7 2.6-1.4c.9-1 2.1-.7 3.5-1.4 1.3-.8 1.9-2.5 1.5-4.5-.6-2.9-2.3-5.4-4-7.4.6-1.3 1-2.7 1-4.3C16.6 2.7 15 0 12 0zm-2 4.4c.6 0 1 .6 1 1.3s-.4 1.3-1 1.3-1-.6-1-1.3.4-1.3 1-1.3zm4 0c.6 0 1 .6 1 1.3s-.4 1.3-1 1.3-1-.6-1-1.3.4-1.3 1-1.3zM10.5 7c.4.5.9.8 1.5.8s1.1-.3 1.5-.8c.3.4.5 1 .5 1.5 0 .9-.6 1.5-1.5 1.5h-1c-.9 0-1.5-.6-1.5-1.5 0-.5.2-1.1.5-1.5z" />
    </svg>
  );
}

function AndroidGlyph() {
  return (
    <svg width="12" height="13" viewBox="0 0 24 26" fill="currentColor" aria-hidden>
      <path d="M7.4 2.2 5.8.4 4.7 1.3l1.7 2C3.8 4.9 2 7.7 2 10.8V20c0 1.4 1.1 2.5 2.5 2.5H6V26h2.3v-3.5h7.4V26H18v-3.5h1.5c1.4 0 2.5-1.1 2.5-2.5v-9.2c0-3.1-1.8-5.9-4.4-7.5l1.7-2L18.2.4l-1.6 1.8C15.2 1.5 13.7 1.1 12 1.1s-3.2.4-4.6 1.1zM7.5 8.9c-.7 0-1.2-.5-1.2-1.2s.5-1.2 1.2-1.2 1.2.5 1.2 1.2-.5 1.2-1.2 1.2zm9 0c-.7 0-1.2-.5-1.2-1.2s.5-1.2 1.2-1.2 1.2.5 1.2 1.2-.5 1.2-1.2 1.2zM4.3 11h15.4v8.7c0 .3-.2.5-.5.5H4.8c-.3 0-.5-.2-.5-.5V11z" />
    </svg>
  );
}
