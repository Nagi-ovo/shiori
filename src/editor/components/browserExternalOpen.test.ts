import { describe, expect, test } from "bun:test";
import { createExternalOpenPrompt } from "./browserExternalOpen";

// A page in the Browser panel can ask for mailto:/tel: links from script,
// with no click and as often as it likes. Ways this can go wrong:
// - the link opens although the user said no, or opens a different URL;
// - a burst of requests stacks one prompt on another;
// - a page looping on the request re-prompts the moment the user declines;
// - after a decline, a different page can never ask again;
// - a failing opener leaves the prompt stuck so nothing ever asks again.
function harness(answers: boolean[]) {
  const asked: string[] = [];
  const opened: string[] = [];
  const pending: Array<() => void> = [];
  let failOpen = false;
  const request = createExternalOpenPrompt({
    ask: (url) => {
      asked.push(url);
      const answer = answers.shift() ?? false;
      return new Promise<boolean>((resolve) => pending.push(() => resolve(answer)));
    },
    open: async (url) => {
      if (failOpen) throw new Error("no handler");
      opened.push(url);
    },
  });
  const answerNext = async () => {
    pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    request,
    asked,
    opened,
    answerNext,
    failNextOpen: () => {
      failOpen = true;
    },
  };
}

describe("createExternalOpenPrompt", () => {
  test("opens nothing when the user declines", async () => {
    const h = harness([false]);
    void h.request("mailto:a@b.com", "https://a.com");
    await h.answerNext();
    expect(h.asked).toEqual(["mailto:a@b.com"]);
    expect(h.opened).toEqual([]);
  });

  test("opens exactly the URL the user agreed to", async () => {
    const h = harness([true]);
    void h.request("mailto:a@b.com?subject=hi", "https://a.com");
    await h.answerNext();
    expect(h.opened).toEqual(["mailto:a@b.com?subject=hi"]);
  });

  test("asks once while a prompt is still up", async () => {
    const h = harness([true]);
    void h.request("mailto:a@b.com", "https://a.com");
    void h.request("mailto:x@y.com", "https://a.com");
    await h.answerNext();
    expect(h.asked).toEqual(["mailto:a@b.com"]);
    expect(h.opened).toEqual(["mailto:a@b.com"]);
  });

  test("stops asking on a page the user declined, until the page changes", async () => {
    const h = harness([false, true]);
    void h.request("mailto:a@b.com", "https://spam.example");
    await h.answerNext();
    void h.request("mailto:a@b.com", "https://spam.example");
    expect(h.asked).toHaveLength(1);

    void h.request("mailto:a@b.com", "https://other.example");
    await h.answerNext();
    expect(h.asked).toHaveLength(2);
    expect(h.opened).toEqual(["mailto:a@b.com"]);
  });

  test("asks again after the opener failed", async () => {
    const h = harness([true, false]);
    h.failNextOpen();
    void h.request("mailto:a@b.com", "https://a.com");
    await h.answerNext();
    void h.request("mailto:a@b.com", "https://a.com");
    expect(h.asked).toHaveLength(2);
  });
});
