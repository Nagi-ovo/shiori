// Consent for links a Browser panel page wants to hand to another app
// (mailto:, and tel: on mobile). The native side no longer opens them: any
// page could do that from script, without a click, in a loop. It reports the
// request instead, and this asks the user first, as a browser would.

export type ExternalOpenDeps = {
  // Resolves true when the user agrees to open `url`.
  ask: (url: string) => Promise<boolean>;
  open: (url: string) => Promise<void>;
};

// `pageUrl` is the panel's page when the request arrived. One prompt at a
// time; once the user declines, that page gets no further prompts (a loop
// would otherwise re-ask the instant the dialog closed) until the panel moves
// to another page.
export function createExternalOpenPrompt(deps: ExternalOpenDeps) {
  let asking = false;
  let declinedOn: string | null = null;
  return async function request(url: string, pageUrl: string | null): Promise<void> {
    if (asking) return;
    if (declinedOn !== null && declinedOn === pageUrl) return;
    asking = true;
    try {
      if (await deps.ask(url)) {
        declinedOn = null;
        await deps.open(url);
      } else {
        declinedOn = pageUrl;
      }
    } catch {
      // A failed prompt or opener leaves the next request free to ask.
    } finally {
      asking = false;
    }
  };
}
