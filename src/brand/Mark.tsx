// Shiori brand marks.
//
// Two pieces, sized independently, reused wherever the brand appears:
//   <ShioriTile />     — the 栞-on-current-accent rounded square; works as a
//                        favicon, a corner badge in the top bar, a splash
//                        element on the landing hero.
//   <ShioriStacked />  — the full stacked wordmark (栞 / Shiori / しおり)
//                        used on the landing page and any "about" surface.
//
// The glyphs are plain text so they inherit Google Fonts (Shippori Mincho
// for the kanji, Klee One for the Latin). If the font CDN is unreachable
// the system kanji face takes over via the font stack in tokens.ts.

import { T } from "../design/tokens";
import { SHIORI_GLYPH_PATH, SHIORI_GLYPH_VIEWBOX } from "./shioriGlyphPath";

type TileProps = {
  size?: number;
  radius?: number; // 0..1 fraction of size
  background?: string;
  color?: string;
  title?: string;
};

// The 栞 mark as a vector outline (see shioriGlyphPath.ts). fill:currentColor
// so it inherits the surrounding text colour and follows the theme; the glyph
// fills its viewBox, so it centres geometrically with no baseline nudge.
export function ShioriGlyph({
  size,
  color = "currentColor",
}: {
  size: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={SHIORI_GLYPH_VIEWBOX}
      fill={color}
      aria-hidden
      style={{ display: "block" }}
    >
      <path transform="scale(1 -1)" d={SHIORI_GLYPH_PATH} />
    </svg>
  );
}

export function ShioriTile({
  size = 28,
  radius = 0.22,
  background = T.accent,
  color = T.logoOnAccent,
  title = "Shiori",
}: TileProps) {
  return (
    <span
      aria-label={title}
      title={title}
      role="img"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flex: "0 0 auto",
        background,
        color,
        borderRadius: size * radius,
        userSelect: "none",
      }}
    >
      <ShioriGlyph size={size * 0.66} />
    </span>
  );
}

type StackedProps = {
  scale?: number;
  dark?: boolean;
  showSubtitle?: boolean;
};

export function ShioriStacked({
  scale = 1,
  dark = false,
  showSubtitle = true,
}: StackedProps) {
  const ink = dark ? T.cream : T.ink;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12 * scale,
        userSelect: "none",
      }}
    >
      <ShioriGlyph size={180 * scale} color={T.brandAccent} />
      <div
        style={{
          fontFamily: T.klee,
          fontWeight: 600,
          fontSize: 52 * scale,
          lineHeight: 1,
          color: ink,
        }}
      >
        Shiori
      </div>
      {showSubtitle ? (
        <div
          style={{
            fontFamily: T.mono,
            fontWeight: 500,
            fontSize: 11 * scale,
            lineHeight: 1,
            color: dark ? "#a89f87" : T.dim,
            letterSpacing: ".22em",
            textTransform: "lowercase",
          }}
        >
          しおり
        </div>
      ) : null}
    </div>
  );
}

// A compact horizontal lockup — tile + klee wordmark. Used in the top bar
// and anywhere space is tight but we still want the full brand expressed.
type LockupProps = {
  size?: number;
  showSubtitle?: boolean;
  muted?: boolean;
};

export function ShioriLockup({ size = 24, showSubtitle = false, muted }: LockupProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.4,
      }}
    >
      <ShioriTile size={size} radius={0.22} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "baseline",
          gap: size * 0.35,
        }}
      >
        <span
          style={{
            fontFamily: T.klee,
            fontWeight: 600,
            fontSize: size * 0.78,
            lineHeight: 1,
            color: muted ? T.ink2 : T.ink,
            letterSpacing: "-.005em",
          }}
        >
          Shiori
        </span>
        {showSubtitle ? (
          <span
            style={{
              fontFamily: T.mono,
              fontWeight: 500,
              fontSize: size * 0.42,
              lineHeight: 1,
              color: T.dim,
              letterSpacing: ".18em",
              textTransform: "lowercase",
            }}
          >
            しおり
          </span>
        ) : null}
      </span>
    </span>
  );
}
