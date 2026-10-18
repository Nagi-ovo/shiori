import type { DocumentKind } from "../documents/types";
import { CAPABILITIES } from "./index";

export type FolderEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  kind: DocumentKind | null;
};

export type FolderListing = {
  entries: FolderEntry[];
  truncated: boolean;
};

export type OpenTargetInfo = {
  path: string;
  isDirectory: boolean;
  kind: DocumentKind | null;
};

export async function pickFolderFromPlatform(): Promise<string[]> {
  if (!CAPABILITIES.nativePaths) return [];
  const { commands, unwrapCommand } = await import("./ipc");
  return unwrapCommand(await commands.pickFolder());
}

export async function classifyOpenTargetFromPlatform(
  path: string,
): Promise<OpenTargetInfo | null> {
  if (!CAPABILITIES.nativePaths) return null;
  const { commands, unwrapCommand } = await import("./ipc");
  return unwrapCommand(await commands.classifyOpenTarget(path));
}

export async function listFolderEntriesFromPlatform(
  path: string,
): Promise<FolderListing | null> {
  if (!CAPABILITIES.nativePaths) return null;
  const { commands, unwrapCommand } = await import("./ipc");
  return unwrapCommand(await commands.listFolderEntries(path));
}
