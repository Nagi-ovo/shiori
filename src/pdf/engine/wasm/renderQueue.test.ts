import { describe, expect, test } from "bun:test";
import { RenderQueue } from "./renderQueue";

const job = (ticket: number, priority: number) => ({ ticket, priority });

function drain(queue: RenderQueue<{ ticket: number; priority: number }>) {
  const out: string[] = [];
  for (let next = queue.take(); next; next = queue.take()) {
    out.push(`${next.job.ticket}${next.cancelled ? "x" : ""}`);
  }
  return out;
}

describe("RenderQueue", () => {
  test("draws tiles on screen before backdrops before thumbnails, in arrival order", () => {
    const queue = new RenderQueue();
    for (const [ticket, priority] of [[1, 2], [2, 2], [3, 1], [4, 0], [5, 0]] as const) {
      queue.push(job(ticket, priority));
    }
    expect(drain(queue)).toEqual(["4", "5", "3", "1", "2"]);
  });

  test("a cancelled render comes up cancelled, the rest are drawn", () => {
    const queue = new RenderQueue();
    queue.push(job(1, 0));
    queue.push(job(2, 0));
    queue.cancel([1]);
    expect(drain(queue)).toEqual(["1x", "2"]);
  });

  test("a cancel that arrives after its render is forgotten once the queue drains", () => {
    const queue = new RenderQueue();
    queue.push(job(1, 0));
    expect(drain(queue)).toEqual(["1"]);
    queue.cancel([1]);
    queue.push(job(2, 0));
    expect(drain(queue)).toEqual(["2"]);
    // Ticket 1 is reused by nothing, but the mark must not linger either.
    queue.push(job(1, 0));
    expect(drain(queue)).toEqual(["1"]);
  });
});
