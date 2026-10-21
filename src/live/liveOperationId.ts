import type { LiveApiAnnotationRequest } from "../platform/liveApi";
import { sha256Hex } from "../storage/hash";
import { liveOperationCanonicalPayload } from "./liveOperation";

export async function deriveLiveOperationId(
  request: Pick<LiveApiAnnotationRequest, "target" | "spec" | "nonce">,
): Promise<string> {
  const canonical = liveOperationCanonicalPayload(
    request.target.sha256,
    request.target.pageTopologyHash,
    request.spec,
    request.nonce,
  );
  return sha256Hex(new TextEncoder().encode(canonical));
}

export async function liveOperationIdMatches(
  request: LiveApiAnnotationRequest,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(request.operationId)) return false;
  return request.operationId === (await deriveLiveOperationId(request));
}
