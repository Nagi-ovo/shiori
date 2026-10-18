import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import {
  CAPABILITIES,
  getProcessMetrics,
  readBrowserMemoryMetrics,
  readGpuAdapterInfo,
  type BrowserMemoryMetrics,
  type GpuRendererInfo,
  type ProcessMetrics,
} from "../../platform";
import { formatBytes } from "../../shared/format";

const RESOURCE_METRICS_REFRESH_MS = 3_000;
const RESOURCE_HISTORY_WINDOW_MS = 10 * 60 * 1_000;
const RESOURCE_HISTORY_MAX_SAMPLES =
  Math.ceil(RESOURCE_HISTORY_WINDOW_MS / RESOURCE_METRICS_REFRESH_MS) + 4;
// CPU is now machine-relative 0-100 (sum of process-tree cpu_usage / cpu_count),
// not the old "percent of one core, can exceed 100".
const CPU_GRAPH_CEILING = 100;
const CPU_PRESSURE_YELLOW = 50;
const CPU_PRESSURE_RED = 80;
// Memory thresholds are tuned for the native process-TREE figure (main process
// + webview helper renderers), which dwarfs the old single-process rss. The
// JS-heap fallback rides the same scale and simply reads as low pressure.
const MEMORY_PRESSURE_YELLOW_BYTES = 1536 * 1024 * 1024; // 1.5 GB
const MEMORY_PRESSURE_RED_BYTES = 3072 * 1024 * 1024; // 3 GB
const MEMORY_GRAPH_CEILING_BYTES = MEMORY_PRESSURE_RED_BYTES * 1.25;

type PressureLevel = "normal" | "elevated" | "critical";
type PressureSample = {
  rawValue: number;
  absoluteValue: number;
  level: PressureLevel;
};

type ResourceMetricSample = {
  at: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  jsHeapBytes: number | null;
};

type ResourceMetricsSnapshot = {
  native: ProcessMetrics | null;
  browserMemory: BrowserMemoryMetrics;
  sampledAt: number | null;
  error: string | null;
};

let resourceMetricHistory: ResourceMetricSample[] = [];

export function ResourceMetricsPanel() {
  const { t } = useTranslation();
  const [gpuInfo, setGpuInfo] = useState<GpuRendererInfo | null>(null);
  const [history, setHistory] = useState<ResourceMetricSample[]>(() =>
    pruneResourceMetricHistory(Date.now()),
  );
  const [snapshot, setSnapshot] = useState<ResourceMetricsSnapshot>(() => ({
    native: null,
    browserMemory: readBrowserMemoryMetrics(),
    sampledAt: null,
    error: null,
  }));

  // GPU adapter info is async (WebGPU requestAdapter), so read it from an effect
  // rather than a useState initializer. Falls back to the WebGL renderer string.
  useEffect(() => {
    let cancelled = false;
    void readGpuAdapterInfo().then((info) => {
      if (!cancelled) setGpuInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let stopped = false;

    const sample = async () => {
      if (typeof document !== "undefined" && document.hidden) return;

      const browserMemory = readBrowserMemoryMetrics();
      try {
        const native = await getProcessMetrics();
        if (stopped) return;
        const sampledAt = Date.now();
        setSnapshot({
          native,
          browserMemory,
          sampledAt,
          error: null,
        });
        setHistory(
          rememberResourceMetricSample({
            at: sampledAt,
            cpuPercent: native?.cpuPercent ?? null,
            memoryBytes: native?.memoryBytes ?? null,
            jsHeapBytes: browserMemory.jsHeapBytes,
          }),
        );
      } catch (err) {
        if (stopped) return;
        const sampledAt = Date.now();
        setSnapshot({
          native: null,
          browserMemory,
          sampledAt,
          error: err instanceof Error ? err.message : String(err),
        });
        setHistory(
          rememberResourceMetricSample({
            at: sampledAt,
            cpuPercent: null,
            memoryBytes: null,
            jsHeapBytes: browserMemory.jsHeapBytes,
          }),
        );
      }
    };

    void sample();
    const id = window.setInterval(() => void sample(), RESOURCE_METRICS_REFRESH_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);

  const cpu = snapshot.native?.cpuPercent;
  const nativeMemory = snapshot.native?.memoryBytes;
  const jsHeap = snapshot.browserMemory.jsHeapBytes;
  const jsHeapLimit = snapshot.browserMemory.jsHeapLimitBytes;
  const loading = snapshot.sampledAt == null;

  // Drive visibility by what this runtime can ACTUALLY measure, not by a
  // hardcoded platform — so the panel composes with native backends arriving
  // on more platforms later. CPU only ever comes from the native backend;
  // memory comes from native (process tree) or the JS heap (Chromium web).
  const nativeCapable = CAPABILITIES.nativeProcessMetrics;
  const heapAvailable = jsHeap != null;
  const memoryFromNative = nativeMemory != null;
  const visibleMemory = nativeMemory ?? jsHeap;

  // Nothing measurable on this runtime (e.g. Safari/Firefox web: no native
  // backend, no performance.memory) → degrade to one honest line instead of
  // empty "Last 10 min" tracks. SettingsPanel:333 needs no platform gate.
  if (!nativeCapable && !heapAvailable) {
    return (
      <div
        style={{
          marginTop: 4,
          padding: "11px 12px",
          background: T.surface,
          border: `1px solid ${T.rule}`,
          borderRadius: 6,
          font: `12px/1.45 ${T.sans}`,
          color: T.dim,
        }}
      >
        {t("settings.resourceMetricsUnsupported")}
      </div>
    );
  }

  const cpuPressureHistory = history
    .map((sample) => sample.cpuPercent)
    .filter(isFiniteNumber);
  const memoryPressureHistory = history
    .map((sample) => sample.memoryBytes ?? sample.jsHeapBytes)
    .filter(isFiniteNumber);
  const cpuPressure = typeof cpu === "number" ? cpuPressureSample(cpu) : null;
  const memoryPressure =
    typeof visibleMemory === "number"
      ? memoryPressureSample(visibleMemory)
      : null;

  const cpuValue =
    typeof cpu === "number"
      ? formatCpuPercent(cpu)
      : loading
        ? t("settings.metricLoading")
        : t("settings.metricUnavailable");
  const memoryValue =
    typeof visibleMemory === "number"
      ? formatBytes(visibleMemory)
      : loading
        ? t("settings.metricLoading")
        : t("settings.metricUnavailable");

  // Memory row identity depends on the source. Native = the whole app process
  // tree → keep the "Memory" label and qualify the value as "App process". The
  // JS-heap fallback relabels the whole ROW "JS heap", so we never imply the
  // heap is the full app footprint.
  const heapText =
    typeof jsHeap === "number"
      ? jsHeapLimit
        ? `${formatBytes(jsHeap)} / ${formatBytes(jsHeapLimit)}`
        : formatBytes(jsHeap)
      : null;
  const memoryLabel = memoryFromNative
    ? t("settings.metricMemory")
    : t("settings.metricMemoryHeap");
  const memoryDetail = (
    memoryFromNative
      ? [
          memoryPressure ? pressureLabel(memoryPressure.level, t) : null,
          t("settings.metricMemoryProcess"),
          heapText ? `${t("settings.metricMemoryHeap")} ${heapText}` : null,
        ]
      : [
          memoryPressure ? pressureLabel(memoryPressure.level, t) : null,
          heapText,
        ]
  )
    .filter(Boolean)
    .join(" · ");
  // Gate the CPU detail on whether a value actually exists, not on the
  // capability bit (fixes the Windows "advertised but null" self-contradiction).
  const cpuDetail = cpuPressure ? pressureLabel(cpuPressure.level, t) : "";

  return (
    <div
      style={{
        marginTop: 4,
        padding: "11px 12px 12px",
        background: T.surface,
        border: `1px solid ${T.rule}`,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 9,
        }}
      >
        <div style={{ font: `600 13px/1.2 ${T.sans}`, color: T.ink }}>
          {t("settings.resourceMetrics")}
        </div>
        <div
          style={{
            font: `500 10.5px/1 ${T.mono}`,
            color: T.dim,
            letterSpacing: ".05em",
            textTransform: "uppercase",
          }}
        >
          {t("settings.resourceMetricsWindow")}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {nativeCapable ? (
          <ResourceMetricRow
            label={t("settings.metricCpu")}
            value={cpuValue}
            detail={cpuDetail}
            pressure={cpuPressureHistory.map(cpuPressureSample)}
          />
        ) : null}
        <ResourceMetricRow
          label={memoryLabel}
          value={memoryValue}
          detail={memoryDetail}
          pressure={memoryPressureHistory.map(memoryPressureSample)}
        />
        <ResourceMetricRow
          label={t("settings.metricGpu")}
          value={gpuInfo?.vendor || t("settings.gpuRendererUnknown")}
          detail={gpuInfo?.renderer ?? ""}
          detailBlock
        />
      </div>
      <div
        style={{
          marginTop: 10,
          font: `12px/1.45 ${T.sans}`,
          color: snapshot.error ? T.rect : T.dim,
        }}
      >
        {snapshot.error
          ? t("settings.resourceMetricsError")
          : t("settings.resourceMetricsHint")}
      </div>
      {nativeCapable ? (
        <div
          style={{
            marginTop: 6,
            font: `12px/1.45 ${T.sans}`,
            color: T.dim,
          }}
        >
          {t("settings.resourceMetricsProcessNote")}
        </div>
      ) : null}
    </div>
  );
}

function ResourceMetricRow({
  label,
  value,
  detail,
  pressure,
  detailBlock,
}: {
  label: string;
  value: string;
  detail: string;
  pressure?: PressureSample[];
  // When the detail is long free-form text (e.g. the GPU renderer string),
  // stack it full-width under the value instead of squeezing it into the
  // right gutter — otherwise it wraps one word per line in the narrow column.
  detailBlock?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "max-content minmax(0, 1fr)",
        alignItems: "start",
        columnGap: 10,
        rowGap: 5,
        minWidth: 0,
      }}
    >
      <div
        style={{
          font: `500 11px/1.2 ${T.mono}`,
          color: T.dim,
          letterSpacing: ".06em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        {detailBlock ? (
          <>
            <div
              style={{
                font: `600 13px/1.3 ${T.mono}`,
                color: T.ink,
                fontVariantNumeric: "tabular-nums",
                overflowWrap: "anywhere",
              }}
            >
              {value}
            </div>
            <div
              style={{
                minWidth: 0,
                font: `12px/1.4 ${T.sans}`,
                color: T.dim,
                overflowWrap: "anywhere",
              }}
              title={detail}
            >
              {detail}
            </div>
          </>
        ) : (
          <div
            style={{
              minWidth: 0,
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                font: `600 13px/1 ${T.mono}`,
                color: T.ink,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                flex: "0 0 auto",
              }}
            >
              {value}
            </div>
            <div
              style={{
                minWidth: 0,
                flex: "1 1 0",
                font: `12px/1.3 ${T.sans}`,
                color: T.dim,
                textAlign: "right",
                overflowWrap: "anywhere",
              }}
              title={detail}
            >
              {detail}
            </div>
          </div>
        )}
        {pressure ? <MetricPressureGraph samples={pressure} /> : null}
      </div>
    </div>
  );
}

function MetricPressureGraph({ samples }: { samples: PressureSample[] }) {
  const visible = samples.slice(-RESOURCE_HISTORY_MAX_SAMPLES);
  const width = RESOURCE_HISTORY_MAX_SAMPLES;
  const height = 34;
  const barWidth = 1;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{
        display: "block",
        width: "100%",
        height,
      }}
    >
      <rect x="0" y="0" width={width} height={height * 0.18} fill="#b13a2e" opacity="0.08" />
      <rect
        x="0"
        y={height * 0.18}
        width={width}
        height={height * 0.22}
        fill="#b88a1e"
        opacity="0.08"
      />
      <rect
        x="0"
        y={height * 0.4}
        width={width}
        height={height * 0.6}
        fill="#2d7a4b"
        opacity="0.07"
      />
      <line
        x1="0"
        y1={height * 0.4}
        x2={width}
        y2={height * 0.4}
        stroke={T.rule}
        strokeWidth="1"
      />
      {visible.map((sample, index) => {
        const clamped = Math.max(0, Math.min(1, sample.absoluteValue));
        const barHeight = Math.max(2, clamped * (height - 4));
        const x = width - visible.length + index * barWidth;
        const y = height - 2 - barHeight;
        return (
          <rect
            key={index}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            rx="0.7"
            fill={pressureColor(sample.level)}
            opacity="0.9"
          />
        );
      })}
    </svg>
  );
}

function cpuPressureSample(percent: number): PressureSample {
  return {
    rawValue: percent,
    absoluteValue: percent / CPU_GRAPH_CEILING,
    level: pressureLevel(percent, CPU_PRESSURE_YELLOW, CPU_PRESSURE_RED),
  };
}

function formatCpuPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

function memoryPressureSample(bytes: number): PressureSample {
  return {
    rawValue: bytes,
    absoluteValue: bytes / MEMORY_GRAPH_CEILING_BYTES,
    level: pressureLevel(
      bytes,
      MEMORY_PRESSURE_YELLOW_BYTES,
      MEMORY_PRESSURE_RED_BYTES,
    ),
  };
}

function pressureLevel(
  value: number,
  yellowAt: number,
  redAt: number,
): PressureLevel {
  if (value >= redAt) return "critical";
  if (value >= yellowAt) return "elevated";
  return "normal";
}

function pressureColor(level: PressureLevel): string {
  if (level === "critical") return "#b13a2e";
  if (level === "elevated") return "#b88a1e";
  return "#2d7a4b";
}

function pressureLabel(
  level: PressureLevel,
  t: (key: string) => string,
): string {
  return t(`settings.metricPressure.${level}`);
}

function rememberResourceMetricSample(
  sample: ResourceMetricSample,
): ResourceMetricSample[] {
  resourceMetricHistory = pruneResourceMetricHistory(sample.at)
    .concat(sample)
    .slice(-RESOURCE_HISTORY_MAX_SAMPLES);
  return resourceMetricHistory;
}

function pruneResourceMetricHistory(now: number): ResourceMetricSample[] {
  const cutoff = now - RESOURCE_HISTORY_WINDOW_MS;
  resourceMetricHistory = resourceMetricHistory.filter(
    (sample) => sample.at >= cutoff,
  );
  return resourceMetricHistory;
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
