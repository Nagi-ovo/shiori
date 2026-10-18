import type { LegalDoc } from "../content/legal";
import { LEGAL_UPDATED } from "../content/legal";
import { linkify } from "./linkify";

// Renders a formal legal/compliance document (Privacy Policy, Support)
// as plain numbered prose with a "last updated" date — the layout an app
// store reviewer expects. Wrapped by DocPage, so Nav, the back link, and
// Footer come from there.
export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <section className="doc-section legal" id="legal">
      <div className="wrap legal-grid">
        <header className="legal-rail">
          <div className="mono label">{doc.kicker}</div>
          <h1 className="legal-title">{doc.title}</h1>
          <div className="mono legal-updated">
            {doc.updatedLabel}: {LEGAL_UPDATED}
          </div>
        </header>

        <div className="legal-body">
          <p className="legal-intro">{linkify(doc.intro)}</p>
          {doc.sections.map((section) => (
            <section className="legal-sec" key={section.heading}>
              <h2>{section.heading}</h2>
              {section.blocks.map((block, i) =>
                "list" in block ? (
                  <ul key={i} className="legal-list">
                    {block.list.map((item, j) => (
                      <li key={j}>{linkify(item)}</li>
                    ))}
                  </ul>
                ) : (
                  <p key={i}>{linkify(block.p)}</p>
                ),
              )}
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
