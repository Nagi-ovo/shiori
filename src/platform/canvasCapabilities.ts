export type CanvasCapabilityIssue =
  | "context2dUnavailable"
  | "pixelReadBlocked"
  | "pixelReadAltered"
  | "imageExportBlocked";

export type CanvasCapabilityReport = {
  ok: boolean;
  origin: string;
  issues: CanvasCapabilityIssue[];
  checkedAt: number;
  detail?: string;
};

const TEST_A = [0x12, 0x34, 0x56, 0xff] as const;
const TEST_B = [0xfe, 0xdc, 0xba, 0xff] as const;

export async function checkCanvasCapabilities(): Promise<CanvasCapabilityReport> {
  const origin = currentOrigin();
  const issues = new Set<CanvasCapabilityIssue>();

  try {
    if (typeof document === "undefined") {
      return report(origin, []);
    }

    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return report(origin, ["context2dUnavailable"]);
    }

    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 8, 16);
    ctx.fillStyle = "#fedcba";
    ctx.fillRect(8, 0, 8, 16);

    try {
      const a = ctx.getImageData(4, 4, 1, 1).data;
      const b = ctx.getImageData(12, 12, 1, 1).data;
      if (!rgbaEquals(a, TEST_A) || !rgbaEquals(b, TEST_B)) {
        issues.add("pixelReadAltered");
      }
    } catch {
      issues.add("pixelReadBlocked");
    }

    try {
      const dataUrl = canvas.toDataURL("image/png");
      if (!dataUrl.startsWith("data:image/png;base64,") || dataUrl.length < 64) {
        issues.add("imageExportBlocked");
      }
    } catch {
      issues.add("imageExportBlocked");
    }

    if (typeof canvas.toBlob === "function") {
      try {
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob((result) => resolve(result), "image/png");
        });
        if (!blob || blob.size === 0) {
          issues.add("imageExportBlocked");
        }
      } catch {
        issues.add("imageExportBlocked");
      }
    }

    return report(origin, Array.from(issues));
  } catch (err) {
    return report(origin, ["context2dUnavailable"], errorMessage(err));
  }
}

function report(
  origin: string,
  issues: CanvasCapabilityIssue[],
  detail?: string,
): CanvasCapabilityReport {
  return {
    ok: issues.length === 0,
    origin,
    issues,
    checkedAt: Date.now(),
    detail,
  };
}

function rgbaEquals(
  actual: Uint8ClampedArray,
  expected: readonly [number, number, number, number],
): boolean {
  return (
    actual[0] === expected[0] &&
    actual[1] === expected[1] &&
    actual[2] === expected[2] &&
    actual[3] === expected[3]
  );
}

function currentOrigin(): string {
  if (typeof location === "undefined") return "";
  return location.origin;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
