export { noteTimestamps } from "../../pdf/model/note";

export function noteDisplayTimestamp(
  note: { createdAt?: number; updatedAt?: number },
): number | null {
  return note.updatedAt ?? note.createdAt ?? null;
}
