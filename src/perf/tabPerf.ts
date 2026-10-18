import type { ProfilerOnRenderCallback } from "react";

const MAX_RECORDED_COMMITS = 1_000;
let publishScheduled = false;

type TabPerfMemorySample = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

export type TabPerfCommit = {
  id: string;
  phase: string;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  memory: TabPerfMemorySample | null;
};

export type TabPerfMetrics = {
  version: 1;
  startedAt: number;
  href: string;
  renders: Record<string, number>;
  gauges: Record<string, number>;
  commits: TabPerfCommit[];
};

export type TabPerfSummary = {
  version: 1;
  startedAt: number;
  href: string;
  renders: Record<string, number>;
  gauges: Record<string, number>;
  commitCount: number;
  actualDurationTotal: number;
  actualDurationMax: number;
  lastMemory: TabPerfMemorySample | null;
};

declare global {
  interface Window {
    __SHIORI_TAB_PERF__?: TabPerfMetrics;
  }
}

export function isTabPerfEnabled(): boolean {
  return import.meta.env.DEV && typeof window !== "undefined";
}

function metrics(): TabPerfMetrics | null {
  if (!isTabPerfEnabled()) return null;
  const current = (window.__SHIORI_TAB_PERF__ ??= freshMetrics());
  current.gauges ??= {};
  return current;
}

function freshMetrics(): TabPerfMetrics {
  return {
    version: 1,
    startedAt: Date.now(),
    href: window.location.href,
    renders: {},
    gauges: {},
    commits: [],
  };
}

function memorySample(): TabPerfMemorySample | null {
  const memory = (
    window.performance as Performance & {
      memory?: TabPerfMemorySample;
    }
  ).memory;
  if (!memory) return null;
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  };
}

function publishSummary(current: TabPerfMetrics): void {
  if (window.__SHIORI_TAB_PERF__ !== current) return;
  const summary: TabPerfSummary = {
    version: current.version,
    startedAt: current.startedAt,
    href: current.href,
    renders: { ...current.renders },
    gauges: { ...current.gauges },
    commitCount: current.commits.length,
    actualDurationTotal: current.commits.reduce(
      (total, commit) => total + commit.actualDuration,
      0,
    ),
    actualDurationMax: current.commits.reduce(
      (maximum, commit) => Math.max(maximum, commit.actualDuration),
      0,
    ),
    lastMemory: current.commits.at(-1)?.memory ?? null,
  };
  const serialized = JSON.stringify(summary);
  document.documentElement.dataset.shioriTabPerf = serialized;
  void fetch("/__shiori_tab_perf", {
    method: "POST",
    body: serialized,
  })
    .then((response) => {
      if (response.status !== 205) return;
      // The Vite probe requested a measurement reset. Replace only the dev
      // counters; the application tree and every open editor store stay live.
      const reset = freshMetrics();
      window.__SHIORI_TAB_PERF__ = reset;
      publishSummary(reset);
    })
    .catch(() => undefined);
}

function scheduleSummary(current: TabPerfMetrics): void {
  if (publishScheduled) return;
  publishScheduled = true;
  queueMicrotask(() => {
    publishScheduled = false;
    publishSummary(current);
  });
}

export function recordTabPerfRender(component: string): void {
  const current = metrics();
  if (!current) return;
  current.renders[component] = (current.renders[component] ?? 0) + 1;
  scheduleSummary(current);
}

export function recordTabPerfGauge(name: string, value: number): void {
  const current = metrics();
  if (!current || current.gauges[name] === value) return;
  current.gauges[name] = value;
  scheduleSummary(current);
}

export const recordTabPerfCommit: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  const current = metrics();
  if (!current) return;
  current.commits.push({
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
    memory: memorySample(),
  });
  if (current.commits.length > MAX_RECORDED_COMMITS) {
    current.commits.splice(0, current.commits.length - MAX_RECORDED_COMMITS);
  }
  publishSummary(current);
};
