import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { WEBRTC_GUARD } from "./runnableHtmlWebRtcGuard";

// The run frame's WebRTC guard against a real DOM (happy-dom), where the
// mutation records and parser behaviour are the engine's, not the fakes'
// in runnableHtmlWebRtcGuard.test.ts.

describe("run frame WebRTC guard in a real DOM", () => {
  test("a srcdoc frame put in by any route runs the guard before its own scripts", async () => {
    // Each route here got a working peer connection, with server-reflexive
    // candidates, in Chrome on 2026-10-21 before the observer prefixed them.
    // Runs against a real DOM so the mutation records are the engine's.
    const guard = "data:text/javascript,guard";
    const prefix = `<script src="${guard}"></script>`;
    const user = "<p>user</p>";
    const tag = `<iframe srcdoc="${user}"></iframe>`;
    type Route = (doc: Document, host: HTMLElement) => ParentNode;
    const routes: Record<string, Route> = {
      innerHTML: (_doc, host) => {
        host.innerHTML = tag;
        return host;
      },
      insertAdjacentHTML: (_doc, host) => {
        host.insertAdjacentHTML("beforeend", tag);
        return host;
      },
      outerHTML: (doc, host) => {
        host.appendChild(doc.createElement("div")).outerHTML = tag;
        return host;
      },
      setAttributeNode: (doc, host) => {
        const frame = doc.createElement("iframe");
        const attr = doc.createAttribute("srcdoc");
        attr.value = user;
        frame.setAttributeNode(attr);
        host.appendChild(frame);
        return host;
      },
      attrValueAfterInsert: (doc, host) => {
        const frame = host.appendChild(doc.createElement("iframe"));
        frame.setAttribute("srcdoc", "<p>x</p>");
        frame.getAttributeNode("srcdoc")!.value = user;
        return host;
      },
      templateClone: (doc, host) => {
        const template = doc.createElement("template");
        template.innerHTML = tag;
        host.appendChild(template.content.cloneNode(true));
        return host;
      },
      contextualFragment: (doc, host) => {
        host.appendChild(doc.createRange().createContextualFragment(tag));
        return host;
      },
      closedShadowRoot: (_doc, host) => {
        const root = host.attachShadow({ mode: "closed" });
        root.innerHTML = tag;
        return root;
      },
    };
    for (const [name, route] of Object.entries(routes)) {
      const win = new Window({ url: "http://localhost/" });
      const doc = win.document as unknown as Document;
      Object.defineProperty(doc, "currentScript", { value: { src: guard } });
      new Function("window", "document", WEBRTC_GUARD)(win, doc);
      const host = doc.body.appendChild(doc.createElement("div"));
      const scope = route(doc, host);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const frames = Array.from(scope.querySelectorAll("iframe"));
      expect({ name, count: frames.length }).toEqual({ name, count: 1 });
      expect({ name, srcdoc: frames[0]!.getAttribute("srcdoc") }).toEqual({
        name,
        srcdoc: prefix + user,
      });
      await win.happyDOM.close();
    }
  });

  test("markup without a srcdoc reaches setHTMLUnsafe unchanged", () => {
    // Re-parsing through a template would nest sibling SVG elements.
    const win = new Window({ url: "http://localhost/" });
    const doc = win.document as unknown as Document;
    const received: string[] = [];
    const proto = win.Element.prototype as unknown as Record<string, unknown>;
    proto.setHTMLUnsafe = function (html: string) {
      received.push(html);
    };
    Object.defineProperty(doc, "currentScript", { value: { src: "data:text/javascript,guard" } });
    new Function("window", "document", WEBRTC_GUARD)(win, doc);
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    const markup = "<circle/><rect/>";
    (svg as unknown as { setHTMLUnsafe: (html: string) => void }).setHTMLUnsafe(markup);
    expect(received).toEqual([markup]);
  });
});
