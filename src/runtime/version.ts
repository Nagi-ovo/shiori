declare const __APP_VERSION__: string;

export const appVersion = __APP_VERSION__;

export function compareSemver(a: string, b: string): number {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function semverParts(version: string): number[] {
  return version
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}
