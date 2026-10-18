// Pure formatting helpers. No i18n here — callers pass labels when needed
// so these functions stay side-effect free and easy to test.

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// "47h 12m" · "59m" · "33s" · "0s" — compact, no trailing zeros.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ${hr % 24}h`;
  if (hr > 0) return `${hr}h ${min % 60}m`;
  if (min > 0) return `${min}m`;
  return `${sec}s`;
}

// "2 min ago", "just now", "3 hours ago", "yesterday", "3d ago"
export function formatRelative(
  pastMs: number,
  now: number = Date.now(),
  labels: RelativeLabels = EN_RELATIVE,
): string {
  const delta = Math.max(0, now - pastMs);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return labels.justNow;
  const min = Math.floor(sec / 60);
  if (min < 60) return labels.minAgo(min);
  const hr = Math.floor(min / 60);
  if (hr < 24) return labels.hrAgo(hr);
  const day = Math.floor(hr / 24);
  if (day < 7) return labels.dayAgo(day);
  return labels.dayAgo(day);
}

/**
 * The earliest instant after `now` at which formatRelative(pastMs, …) would
 * produce a different string, so a display can re-render exactly then
 * instead of polling. Boundaries mirror formatRelative: 45s, then whole
 * minutes, hours and days measured from `pastMs`.
 */
export function nextRelativeChangeAt(pastMs: number, now: number = Date.now()): number {
  const delta = Math.max(0, now - pastMs);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return pastMs + 45_000;
  const min = Math.floor(sec / 60);
  if (min < 60) return pastMs + (min + 1) * 60_000;
  const hr = Math.floor(min / 60);
  if (hr < 24) return pastMs + (hr + 1) * 3_600_000;
  const day = Math.floor(hr / 24);
  return pastMs + (day + 1) * 86_400_000;
}

export type RelativeLabels = {
  justNow: string;
  minAgo: (n: number) => string;
  hrAgo: (n: number) => string;
  dayAgo: (n: number) => string;
};

export const EN_RELATIVE: RelativeLabels = {
  justNow: "just now",
  minAgo: (n) => `${n} min ago`,
  hrAgo: (n) => `${n} h ago`,
  dayAgo: (n) => `${n} d ago`,
};

export const ZH_RELATIVE: RelativeLabels = {
  justNow: "刚刚",
  minAgo: (n) => `${n} 分钟前`,
  hrAgo: (n) => `${n} 小时前`,
  dayAgo: (n) => `${n} 天前`,
};

export const JA_RELATIVE: RelativeLabels = {
  justNow: "たった今",
  minAgo: (n) => `${n} 分前`,
  hrAgo: (n) => `${n} 時間前`,
  dayAgo: (n) => `${n} 日前`,
};

export function relativeLabelsFor(
  lang: string | undefined,
): RelativeLabels {
  const normalized = (lang ?? "en").toLowerCase();
  if (normalized.startsWith("zh")) return ZH_RELATIVE;
  if (normalized.startsWith("ja")) return JA_RELATIVE;
  return EN_RELATIVE;
}
