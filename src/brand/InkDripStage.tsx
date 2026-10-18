// Landing hero ink effect. A WebGL fluid sim sits in the background;
// an SVG pendant drop hangs from the 栞 logo, detaches, falls, and
// splatters a persistent ink bloom into the fluid field.
//
// The drop is rendered as a single <path> that reshapes every frame.
// During condensation the path is a pendant profile attached to the
// logo (narrow neck, widening into a bulb, rounded base). During fall
// the same builder produces a free-form teardrop (pointy top, wide
// belly) with no attachment. This way the liquid reads as a single
// continuous body in both phases — not a bead on a stick.
//
// On impact we don't just push a single downward splat; the landing
// fires a radial burst of ten small splats arranged in a circle, each
// carrying outward velocity. That gives the dye field a sustained
// outward-spreading motion — the bloom keeps growing for seconds,
// instead of the single pulse dying the moment velocity dissipates.
//
// If the user has prefers-reduced-motion, we render nothing.

import { useEffect, useRef, useState } from "react";
import { SHIORI_BRAND } from "../design/tokens";
import {
  createFluidSimulation,
  type FluidSimulation,
} from "./fluid/simulation";

// Temporarily disable the whole ink-drip stage (pendant drop animation
// + WebGL fluid canvas). All code below stays intact — flip this back
// to false to bring the effect back without reintegrating. Kept as a
// single on/off so future design iterations can resume cleanly.
const HIDDEN = true;

type Props = {
  // The element the drop hangs from — usually the 栞 tile on the
  // Landing hero. The drop's neck anchors to its horizontal midpoint,
  // a couple of pixels inside the bottom edge so it reads as seeping
  // from the logo rather than clinging to its outline.
  sourceRef: React.RefObject<HTMLElement | null>;
};

type Phase = "rest" | "grow" | "stretch" | "fall";

type Point = { x: number; y: number };

// Tunables.
const REST_MS = 1200;
const GROW_MS = 2800; // bulb grows to peak under surface tension
const STRETCH_MS = 420; // neck thins + bulb accelerates downward (Plateau-Rayleigh)
const STRETCH_DROP_PX = 13; // bulb equator sinks this far during stretch
const STRETCH_NECK_FLOOR = 0.17; // neck half-width at the moment of snap
const FALL_GRAVITY = 1800; // px/s²
const FALL_HANDOFF_VY = 120; // downward speed the bulb has already gained by snap
const DROP_MAX_BULB_R = 5.0; // peak bulb half-width at detach
const DROP_MAX_NECK_R = 1.25; // attachment half-width at grow end
const DROP_MAX_STEM_LEN = 5.0; // neck-to-bulb distance at grow end
const STUB_MS = 220; // post-snap residual stub retraction into the logo
// Drop falls straight down from directly under the logo. The bloom
// gets its rightward bias at splat time (not during the fall) so the
// drift reads as "ink seeping east in water" rather than as a wind
// carrying the drop itself sideways. Land low — below the drop zone
// and continue-last button — so the bloom opens into empty paper
// rather than pooling behind opaque-looking content.
const LANDING_FRAC_Y = 0.87;

// Build a single closed path for a pendant-drop / teardrop. Drawn
// clockwise from top-right; mirrored left side for symmetry. Used for
// both condensation (r0 > 0, topRound = 0, attached to logo) and
// free-fall (r0 = 0, topRound ≈ 1, egg-like).
//
//   ax, ay    — apex / attachment point in stage px
//   r0        — half-width at apex (0 for detached drop; > 0 for pendant neck)
//   rMax      — half-width at widest point (bulb equator)
//   yEq       — y distance from apex to bulb equator (widest band)
//   h         — y distance from apex to bulb bottom
//   topRound  — 0..1: 0 pulls the top tangent vertical (pendant neck
//               goes straight down); 1 pulls it horizontal (rounded
//               dome, no pointy tail). Between these, the top blends
//               smoothly.
function buildDropPath(
  ax: number,
  ay: number,
  r0: number,
  rMax: number,
  yEq: number,
  h: number,
  topRound: number,
): string {
  // The apex tangent interpolates from vertical (pendant, topRound=0)
  // to horizontal (round, topRound=1). We lerp the first control point
  // along both axes accordingly.
  const tr = Math.min(Math.max(topRound, 0), 1);
  const top_cp1x = ax + r0 + (rMax - r0) * 0.6 * tr;
  const top_cp1y = ay + yEq * (0.42 * (1 - tr));
  const top_cp2x = ax + rMax;
  const top_cp2y = ay + yEq * (0.68 - 0.22 * tr);

  const eqRightX = ax + rMax;
  const eqRightY = ay + yEq;

  const bot_cp1x = ax + rMax;
  const bot_cp1y = ay + yEq + (h - yEq) * 0.6;
  const bot_cp2x = ax + rMax * 0.35;
  const bot_cp2y = ay + h;

  const bot2_cp1x = ax - rMax * 0.35;
  const bot2_cp1y = ay + h;
  const bot2_cp2x = ax - rMax;
  const bot2_cp2y = ay + yEq + (h - yEq) * 0.6;

  const eqLeftX = ax - rMax;
  const eqLeftY = ay + yEq;

  const top2_cp1x = ax - rMax;
  const top2_cp1y = ay + yEq * (0.68 - 0.22 * tr);
  const top2_cp2x = ax - r0 - (rMax - r0) * 0.6 * tr;
  const top2_cp2y = ay + yEq * (0.42 * (1 - tr));

  return [
    `M ${ax + r0} ${ay}`,
    `C ${top_cp1x} ${top_cp1y}, ${top_cp2x} ${top_cp2y}, ${eqRightX} ${eqRightY}`,
    `C ${bot_cp1x} ${bot_cp1y}, ${bot_cp2x} ${bot_cp2y}, ${ax} ${ay + h}`,
    `C ${bot2_cp1x} ${bot2_cp1y}, ${bot2_cp2x} ${bot2_cp2y}, ${eqLeftX} ${eqLeftY}`,
    `C ${top2_cp1x} ${top2_cp1y}, ${top2_cp2x} ${top2_cp2y}, ${ax - r0} ${ay}`,
    `Z`,
  ].join(" ");
}

export function InkDripStage({ sourceRef }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const stubRef = useRef<SVGPathElement>(null);
  const simRef = useRef<FluidSimulation | null>(null);
  const [reduced, setReduced] = useState(false);

  // Detect reduced-motion (listen for changes — users can flip it live).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Boot the WebGL sim once the canvas is in the DOM.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reduced) return;
    const sim = createFluidSimulation(canvas);
    simRef.current = sim;
    if (sim.supported) sim.start();
    return () => {
      sim.dispose();
      simRef.current = null;
    };
  }, [reduced]);

  // Orchestrator: runs the drop state machine and updates the SVG path.
  useEffect(() => {
    if (reduced) return;
    const stage = stageRef.current;
    const path = pathRef.current;
    const stub = stubRef.current;
    if (!stage || !path || !stub) return;

    let raf = 0;
    let running = true;
    let phase: Phase = "rest";
    let phaseStart = performance.now();
    let lastNow = phaseStart;
    let fallPos: Point = { x: 0, y: 0 };
    let fallVy = 0;
    let target: Point = { x: 0, y: 0 };
    let source: Point = { x: 0, y: 0 };
    // Snapshot of the drop body at the grow→stretch handoff. Stretch
    // continues the same bulb while the neck thins and the equator
    // drifts downward.
    let stretchStartYEq = 0;
    let stretchStartBulbR = 0;
    let stretchStartBottomExtra = 0;
    let stretchStartNeckR = 0;
    // Post-snap residual stub. -1 means inactive.
    let stubStartTime = -1;
    let stubStartYEq = 0;
    let stubStartBulbR = 0;
    let stubStartBottomExtra = 0;

    // Ring-shaped splat waves queued after impact. Fired on the tick
    // loop once their `fireAt` timestamp has passed. No single central
    // splat — the impact point always stays hollow, and each wave adds
    // an expanding ring of dye that the fluid field carries outward.
    type Wave = {
      fireAt: number;
      cx: number;
      cy: number;
      ringRadius: number; // stage px
      outwardSpeed: number; // stage px/s — how fast this ring tries to expand
      count: number;
      splatRadius: number; // Gaussian falloff for individual splat
    };
    const waves: Wave[] = [];

    const measure = () => {
      const stageRect = stage.getBoundingClientRect();
      const srcEl = sourceRef.current;
      if (!srcEl) return;
      const srcRect = srcEl.getBoundingClientRect();
      source = {
        x: srcRect.left + srcRect.width / 2 - stageRect.left,
        // Push the attachment 2 px up *into* the logo — the logo sits
        // above the stage in z-order, so the pendant's neck (which is
        // narrower than the logo's bottom edge) is hidden, making the
        // drop read as seeping out from under the logo rather than
        // stuck to its outline.
        y: srcRect.bottom - stageRect.top - 2,
      };
      target = {
        // Straight down from the logo — no horizontal drift during the
        // fall itself. Drift is applied later, during the ink bloom.
        x: source.x,
        y: stageRect.height * LANDING_FRAC_Y,
      };
    };
    measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => measure());
    ro.observe(stage);

    // The drop comes directly from the logo, so it keeps the fixed Shiori
    // blue even when the user personalises the application accent.
    const brandAccent = parseHexColor(SHIORI_BRAND.accent) ?? [0.2, 0.53, 0.73];

    const hidePath = () => {
      path.setAttribute("d", "");
    };

    // Queue a series of ring-shaped waves at a landing point. Waves
    // are fired across the next ~520ms so that by the time the 4th
    // wave emits at the centre, the 1st wave has already expanded into
    // the largest ring — producing concentric "ink on water" rings
    // rather than a single pool.
    //
    // outwardSpeed feeds directly into sim.splat's dx/dy, which the
    // simulation multiplies by splatForce (6000). The numbers look
    // tiny because a raw value of 3.5 already corresponds to a peak
    // velocity of ~35 in the field — enough to carry dye a few canvas
    // diameters over a few seconds, given low velocityDissipation.
    const scheduleWaves = (px: number, py: number, now: number) => {
      // (delayMs, startRadiusPx, outwardSpeed (sim units), count, splatRadius)
      const recipe: Array<[number, number, number, number, number]> = [
        [0,   6.5, 4.0, 14, 0.15],
        [180, 5.5, 3.0, 14, 0.14],
        [340, 5.0, 2.2, 13, 0.13],
        [520, 4.5, 1.6, 12, 0.12],
      ];
      for (const [delay, ringRadius, outwardSpeed, count, splatRadius] of recipe) {
        waves.push({
          fireAt: now + delay,
          cx: px,
          cy: py,
          ringRadius,
          outwardSpeed,
          count,
          splatRadius,
        });
      }
    };

    const jitter = (amount: number) => (Math.random() - 0.5) * 2 * amount;

    // Fire a ring wave into the fluid field. Each splat is a small
    // Gaussian injected with a radially-outward velocity; vorticity in
    // the simulation then carries these into organic filaments.
    const fireWave = (wave: Wave) => {
      const sim = simRef.current;
      if (!sim || !sim.supported) return;
      const stageRect = stage.getBoundingClientRect();
      const sw = Math.max(stageRect.width, 1);
      const sh = Math.max(stageRect.height, 1);
      const nx = wave.cx / sw;
      const ny = 1 - wave.cy / sh;
      const rxN = wave.ringRadius / sw;
      // outwardSpeed is the raw sim-side dx/dy magnitude — no stage
      // rescaling, since the values in scheduleWaves are already
      // chosen relative to the fluid field, not the screen.
      const baseSpeed = wave.outwardSpeed;
      // Barely-there eastward bias; applied only at the ring and
      // scaled to match outwardSpeed units.
      const rightDrift = 0.2;
      for (let i = 0; i < wave.count; i++) {
        const angle = (i / wave.count) * Math.PI * 2 + jitter(0.18);
        const rr = rxN * (1 + jitter(0.22));
        const ox = Math.cos(angle) * rr;
        const oy = Math.sin(angle) * rr * (sw / sh); // keep ring visually round
        const outward = baseSpeed * (1 + jitter(0.25));
        const dx = Math.cos(angle) * outward + rightDrift;
        // Symmetric in y — no up/down bias, so the ring opens evenly.
        const dy = -Math.sin(angle) * outward;
        const radiusJ = wave.splatRadius * (1 + jitter(0.22));
        sim.splat(nx + ox, ny - oy, dx, dy, {
          color: brandAccent,
          radius: radiusJ,
        });
      }
    };

    const tick = (now: number) => {
      if (!running) return;
      const elapsed = now - phaseStart;
      const dt = Math.min(0.033, (now - lastNow) / 1000);
      lastNow = now;

      // Fire any pending ring waves whose time has come.
      for (let i = waves.length - 1; i >= 0; i--) {
        if (now >= waves[i]!.fireAt) {
          fireWave(waves[i]!);
          waves.splice(i, 1);
        }
      }

      // Post-snap residual stub — shrinks from the pendant-at-snap
      // shape down to nothing over STUB_MS so the thread reads as
      // pulled back into the logo, not abruptly erased.
      if (stubStartTime >= 0) {
        const st = (now - stubStartTime) / STUB_MS;
        if (st >= 1) {
          stub.setAttribute("d", "");
          stubStartTime = -1;
        } else {
          // ease-out cubic — retracts fast at first, settles as it
          // approaches the logo. The stub uses the same pendant
          // profile as stretch, but with all dimensions scaled
          // toward zero.
          const scale = 1 - (1 - Math.pow(1 - st, 3));
          const yEq = stubStartYEq * scale;
          const h = yEq + stubStartBottomExtra * scale;
          const bulbR = stubStartBulbR * scale;
          const neckR = Math.max(0.6 * scale, 0.05);
          stub.setAttribute(
            "d",
            buildDropPath(source.x, source.y, neckR, bulbR, yEq, h, 0),
          );
        }
      }

      if (phase === "rest") {
        hidePath();
        if (elapsed >= REST_MS) {
          phase = "grow";
          phaseStart = now;
        }
      } else if (phase === "grow") {
        const t = Math.min(elapsed / GROW_MS, 1);
        // ease-out cubic — swells fast early, lingers near the end
        // where surface tension starts losing the battle.
        const eased = 1 - Math.pow(1 - t, 3);

        // Neck stays narrow the whole time; the *bulb* is what grows.
        const neckR = DROP_MAX_NECK_R * (0.45 + eased * 0.55);
        const bulbR = 1.0 + eased * (DROP_MAX_BULB_R - 1.0);
        const stemLen = eased * DROP_MAX_STEM_LEN;

        // Pendant profile: equator (widest band) sits at stemLen +
        // bulbR * 0.55; total height stemLen + bulbR * 1.85 (taller
        // bulb than wide).
        const yEq = stemLen + bulbR * 0.55;
        const h = stemLen + bulbR * 1.85;

        path.setAttribute(
          "d",
          buildDropPath(source.x, source.y, neckR, bulbR, yEq, h, 0),
        );

        if (t >= 1) {
          phase = "stretch";
          phaseStart = now;
          stretchStartYEq = yEq;
          stretchStartBulbR = bulbR;
          stretchStartBottomExtra = h - yEq;
          stretchStartNeckR = neckR;
        }
      } else if (phase === "stretch") {
        // Plateau-Rayleigh-ish breakup: the bulb begins falling under
        // gravity while still attached; the neck thins rapidly into a
        // visible thread that elongates before it snaps. An ease-in
        // quartic holds the neck briefly, then rips it thin fast —
        // matches the way real pendant drops hang, then let go.
        const t = Math.min(elapsed / STRETCH_MS, 1);
        const eased = t * t * t * t;

        const yEq = stretchStartYEq + STRETCH_DROP_PX * eased;
        const h = yEq + stretchStartBottomExtra;
        const neckR =
          stretchStartNeckR + (STRETCH_NECK_FLOOR - stretchStartNeckR) * eased;

        path.setAttribute(
          "d",
          buildDropPath(
            source.x,
            source.y,
            neckR,
            stretchStartBulbR,
            yEq,
            h,
            0,
          ),
        );

        if (t >= 1) {
          phase = "fall";
          phaseStart = now;
          // Hand off with the downward speed stretch already built
          // up, so the fall continues smoothly rather than teleporting
          // to a stationary start.
          fallPos = { x: source.x, y: source.y + yEq };
          fallVy = FALL_HANDOFF_VY;
          // Kick off the post-snap stub retraction — a tiny residual
          // clings to the logo and snaps back up over ~220ms. Without
          // this the long thread just vanishes the frame after snap
          // and the whole fall reads as a twitch/glitch.
          stubStartTime = now;
          stubStartYEq = stretchStartYEq;
          stubStartBulbR = stretchStartBulbR;
          stubStartBottomExtra = stretchStartBottomExtra;
        }
      } else if (phase === "fall") {
        fallVy += FALL_GRAVITY * dt;
        fallPos.y += fallVy * dt;
        // Straight vertical fall — x locked to the source column.
        fallPos.x = source.x;

        // In flight the drop is a rounded egg — surface tension snaps
        // the ex-neck into a rounded dome immediately after detach, so
        // there is no visible tail. Vertical stretch grows gently with
        // speed (air-drag elongation along velocity), but the top and
        // bottom both stay round.
        const speed = Math.abs(fallVy);
        const speedT = Math.min(speed / 900, 1);
        const rx = DROP_MAX_BULB_R * (1 - speedT * 0.18);
        const ry = DROP_MAX_BULB_R * (1 + speedT * 0.42);

        // Equator exactly at midline gives a symmetric ellipse; nudge
        // it slightly past centre so the bulk of the body reads as
        // sitting in the lower half (physically correct for a drop
        // with gravity pulling its centre of mass down).
        const yEq = ry * 1.08;
        const h = ry * 2.0;

        path.setAttribute(
          "d",
          buildDropPath(fallPos.x, fallPos.y - ry, 0, rx, yEq, h, 1),
        );

        if (fallPos.y >= target.y) {
          scheduleWaves(target.x, target.y, now);
          hidePath();
          phase = "rest";
          phaseStart = now;
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  }, [reduced, sourceRef]);

  // HIDDEN renders nothing and leaves all refs null — the existing
  // useEffect early-returns handle the cleanup naturally, so no sim
  // is booted, no RAF runs, no listeners attach.
  if (HIDDEN || reduced) return null;

  return (
    <div
      ref={stageRef}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 0,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          // Plain alpha compositing. Earlier versions used
          // mix-blend-mode: multiply, but WKWebView on macOS has known
          // quirks combining CSS blend modes with a transparent WebGL
          // canvas — the blend can silently produce nothing on screen.
          // Normal alpha gives a near-identical "ink seeping into
          // paper" look: dye RGB = brand blue, paper shows through the
          // alpha channel where dye density is low.
          opacity: 0.85,
        }}
      />
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          overflow: "visible",
        }}
      >
        <path ref={pathRef} fill={SHIORI_BRAND.accent} />
        <path ref={stubRef} fill={SHIORI_BRAND.accent} />
      </svg>
    </div>
  );
}

function parseHexColor(input: string): [number, number, number] | null {
  const hex = input.trim().replace(/^#/, "");
  if (hex.length === 3) {
    const r = parseInt(hex[0]! + hex[0], 16);
    const g = parseInt(hex[1]! + hex[1], 16);
    const b = parseInt(hex[2]! + hex[2], 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return [r / 255, g / 255, b / 255];
  }
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return [r / 255, g / 255, b / 255];
  }
  return null;
}
