// Derived from WebGL-Fluid-Simulation
// (https://github.com/PavelDoGreat/WebGL-Fluid-Simulation),
// Copyright (c) 2017 Pavel Dobryakov, MIT License:
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// WebGL fluid simulation — a trimmed port of PavelDoGreat's
// WebGL-Fluid-Simulation (MIT). Kept only the Navier–Stokes core
// (advect → vorticity → divergence → pressure Jacobi → gradient
// subtract) plus programmatic splats. No pointer/touch handling, no
// bloom, no sunrays, no dat.gui. The canvas is fully transparent; dye
// density drives the alpha so the Landing paper shows through.
//
// The simulation exposes an imperative API:
//   const sim = createFluidSimulation(canvas);
//   sim.start();
//   sim.splat(x, y, dx, dy, { color, radius });   // normalised 0..1
//   sim.stop();
//   sim.dispose();

type SplatOptions = {
  color?: [number, number, number];
  radius?: number; // normalised radius (fraction of min dimension)
};

export type FluidSimulation = {
  start(): void;
  stop(): void;
  resize(): void;
  splat(x: number, y: number, dx: number, dy: number, opts?: SplatOptions): void;
  dispose(): void;
  readonly supported: boolean;
};

type GL = WebGLRenderingContext;

type Config = {
  simResolution: number;
  dyeResolution: number;
  densityDissipation: number;
  velocityDissipation: number;
  pressure: number;
  pressureIterations: number;
  curl: number;
  splatForce: number;
};

const DEFAULT_CONFIG: Config = {
  simResolution: 128,
  dyeResolution: 512,
  // A gentle density fade — each layer lingers a few seconds before
  // the next splat replaces it (~50% at 3s, ~30% at 5s, <1% by 25s).
  // Old blooms clear out on a human timescale so the canvas never
  // accumulates indefinitely. Hue saturation from overlapping splats
  // is handled in the display shader, which normalises accent
  // direction before outputting alpha.
  // Slow density fade (~50% at 3.5s, ~20% at 8s, ~4% at 16s). Gives
  // the bloom enough time to expand visibly before it thins out.
  densityDissipation: 0.2,
  // Low velocity dissipation keeps the initial outward push alive for
  // longer, so dye rings continue to expand instead of stalling at
  // the impact point. Decay still exists so velocity eventually dies
  // and the bloom quiesces.
  velocityDissipation: 0.1,
  pressure: 0.8,
  pressureIterations: 20,
  // Higher curl = stronger vorticity confinement, which exaggerates
  // the small swirls dye picks up from the velocity field. Reads as
  // internal flow and filaments inside the bloom rather than a
  // uniform expanding blob.
  curl: 42,
  splatForce: 6000,
};

type FBO = {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  attach(id: number): number;
};

type DoubleFBO = {
  read: FBO;
  write: FBO;
  swap(): void;
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
};

const VERT = `
precision highp float;
attribute vec2 aPosition;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAG_CLEAR = `
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv;
uniform sampler2D uTexture;
uniform float value;
void main () {
  gl_FragColor = value * texture2D(uTexture, vUv);
}
`;

const FRAG_SPLAT = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main () {
  vec2 p = vUv - point.xy;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  vec3 base = texture2D(uTarget, vUv).xyz;
  gl_FragColor = vec4(base + splat, 1.0);
}
`;

const FRAG_ADVECTION = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform vec2 dyeTexelSize;
uniform float dt;
uniform float dissipation;
vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
  vec2 st = uv / tsize - 0.5;
  vec2 iuv = floor(st);
  vec2 fuv = fract(st);
  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}
void main () {
  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
  vec4 result = bilerp(uSource, coord, dyeTexelSize);
  float decay = 1.0 + dissipation * dt;
  gl_FragColor = result / decay;
  gl_FragColor.a = 1.0;
}
`;

const FRAG_DIVERGENCE = `
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv;
varying highp vec2 vL;
varying highp vec2 vR;
varying highp vec2 vT;
varying highp vec2 vB;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

const FRAG_CURL = `
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv;
varying highp vec2 vL;
varying highp vec2 vR;
varying highp vec2 vT;
varying highp vec2 vB;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}
`;

const FRAG_VORTICITY = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 velocity = texture2D(uVelocity, vUv).xy;
  velocity += force * dt;
  velocity = min(max(velocity, -1000.0), 1000.0);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

const FRAG_PRESSURE = `
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv;
varying highp vec2 vL;
varying highp vec2 vR;
varying highp vec2 vT;
varying highp vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  float divergence = texture2D(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

const FRAG_GRADIENT = `
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv;
varying highp vec2 vL;
varying highp vec2 vR;
varying highp vec2 vT;
varying highp vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  vec2 velocity = texture2D(uVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

const FRAG_DISPLAY = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uAspect; // canvas w/h ratio as (w/min, h/min), for round noise cells

// 2D value noise + fBm for paper-fibre / ink-bleed texture. Static in
// screen space — the paper doesn't move, only the ink flows through
// its grain. Implemented inline rather than pulled from a library so
// there's no runtime dependency.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return v;
}

void main () {
  // Keep noise cells round regardless of canvas aspect.
  vec2 np = vUv * uAspect;

  // Low-frequency displacement for organic wavy edges — like ink
  // bleeding along paper fibres. Offset the second channel so x/y
  // displacements decorrelate.
  float nx = fbm(np * 3.6);
  float ny = fbm(np * 3.6 + vec2(5.2, 1.3));
  vec2 disp = (vec2(nx, ny) - 0.5) * 0.012;
  vec2 uv = vUv + disp;

  vec3 c = texture2D(uTexture, uv).rgb;
  // Density = max channel. Normalise the RGB vector so the hue stays
  // accent-coloured even after repeat splats saturate individual
  // channels — otherwise hotspots drift toward white (bluer channels
  // hit 1 first while red lags).
  float density = max(max(c.r, c.g), c.b);

  // High-frequency grain — fibre-scale variation in absorption. Only
  // where dye exists; empty paper stays clean.
  float grain = 0.78 + 0.22 * fbm(np * 11.0);
  density *= grain;

  // Secondary "veining" at mid frequency carves lighter channels
  // through the bloom, reading as the dark pigment following water
  // lines on paper rather than pooling uniformly.
  float vein = smoothstep(0.35, 0.75, fbm(np * 6.5));
  density *= mix(0.72, 1.0, vein);

  float safe = max(density, 0.0001);
  vec3 hue = clamp(c / safe, 0.0, 1.0);
  float alpha = clamp(density, 0.0, 1.0);
  gl_FragColor = vec4(hue, alpha);
}
`;

function compileShader(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

function linkProgram(gl: GL, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Pin aPosition to attrib 0 so vertexAttribPointer(0, ...) addresses it.
  // Drivers otherwise may choose any location and the full-screen quad
  // never draws.
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${log}`);
  }
  return program;
}

// Superset of uniforms across the stripped fluid pipeline. Any single
// shader uses a subset; TypeScript sees required fields so call sites
// stay clean, and we only read a uniform from a shader that actually
// declares it (so missing locations never round-trip through gl.*).
type Uniforms = {
  uTexture: WebGLUniformLocation;
  value: WebGLUniformLocation;
  uTarget: WebGLUniformLocation;
  aspectRatio: WebGLUniformLocation;
  color: WebGLUniformLocation;
  point: WebGLUniformLocation;
  radius: WebGLUniformLocation;
  uVelocity: WebGLUniformLocation;
  uSource: WebGLUniformLocation;
  texelSize: WebGLUniformLocation;
  dyeTexelSize: WebGLUniformLocation;
  dt: WebGLUniformLocation;
  dissipation: WebGLUniformLocation;
  uCurl: WebGLUniformLocation;
  curl: WebGLUniformLocation;
  uDivergence: WebGLUniformLocation;
  uPressure: WebGLUniformLocation;
  uAspect: WebGLUniformLocation;
};

function getUniforms(gl: GL, program: WebGLProgram): Uniforms {
  const uniforms = {} as Record<string, WebGLUniformLocation>;
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const loc = gl.getUniformLocation(program, info.name);
    if (loc) uniforms[info.name] = loc;
  }
  return uniforms as Uniforms;
}

type WebGLExt = {
  formatRGBA: { internalFormat: number; format: number };
  formatRG: { internalFormat: number; format: number };
  formatR: { internalFormat: number; format: number };
  halfFloatTexType: number;
  supportLinearFiltering: boolean;
};

function getWebGLContext(canvas: HTMLCanvasElement): { gl: GL; ext: WebGLExt } | null {
  const params: WebGLContextAttributes = {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
  };

  const gl2 = canvas.getContext("webgl2", params) as WebGL2RenderingContext | null;
  const isWebGL2 = !!gl2;
  const gl = (gl2 ?? canvas.getContext("webgl", params) ?? canvas.getContext("experimental-webgl", params)) as GL | null;
  if (!gl) return null;

  let halfFloat: { HALF_FLOAT_OES: number } | null = null;
  let supportLinearFiltering: unknown = null;
  if (isWebGL2) {
    (gl as WebGL2RenderingContext).getExtension("EXT_color_buffer_float");
    supportLinearFiltering = (gl as WebGL2RenderingContext).getExtension("OES_texture_float_linear");
  } else {
    halfFloat = gl.getExtension("OES_texture_half_float") as { HALF_FLOAT_OES: number } | null;
    supportLinearFiltering = gl.getExtension("OES_texture_half_float_linear");
  }
  gl.clearColor(0, 0, 0, 0);

  const halfFloatTexType = isWebGL2
    ? (gl as WebGL2RenderingContext).HALF_FLOAT
    : halfFloat?.HALF_FLOAT_OES ?? gl.UNSIGNED_BYTE;

  const gl2Typed = isWebGL2 ? (gl as WebGL2RenderingContext) : null;
  const rgba = gl2Typed
    ? { internalFormat: gl2Typed.RGBA16F, format: gl2Typed.RGBA }
    : { internalFormat: gl.RGBA, format: gl.RGBA };
  const rg = gl2Typed
    ? { internalFormat: gl2Typed.RG16F, format: gl2Typed.RG }
    : { internalFormat: gl.RGBA, format: gl.RGBA };
  const r = gl2Typed
    ? { internalFormat: gl2Typed.R16F, format: gl2Typed.RED }
    : { internalFormat: gl.RGBA, format: gl.RGBA };

  const formatRGBA = supportedFormat(gl, rgba.internalFormat, rgba.format, halfFloatTexType) ?? { internalFormat: gl.RGBA, format: gl.RGBA };
  const formatRG = supportedFormat(gl, rg.internalFormat, rg.format, halfFloatTexType) ?? formatRGBA;
  const formatR = supportedFormat(gl, r.internalFormat, r.format, halfFloatTexType) ?? formatRGBA;

  return {
    gl,
    ext: {
      formatRGBA,
      formatRG,
      formatR,
      halfFloatTexType,
      supportLinearFiltering: !!supportLinearFiltering,
    },
  };
}

function supportedFormat(gl: GL, internalFormat: number, format: number, type: number): { internalFormat: number; format: number } | null {
  if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
    // Fallback cascade for WebGL2: R16F → RG16F → RGBA16F
    const gl2 = (gl as unknown as WebGL2RenderingContext);
    if (internalFormat === gl2.R16F) return supportedFormat(gl, gl2.RG16F, gl2.RG, type);
    if (internalFormat === gl2.RG16F) return supportedFormat(gl, gl2.RGBA16F, gl2.RGBA, type);
    return null;
  }
  return { internalFormat, format };
}

function supportRenderTextureFormat(gl: GL, internalFormat: number, format: number, type: number): boolean {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.deleteTexture(texture);
  gl.deleteFramebuffer(fbo);
  return status === gl.FRAMEBUFFER_COMPLETE;
}

export function createFluidSimulation(
  canvas: HTMLCanvasElement,
  overrides: Partial<Config> = {},
): FluidSimulation {
  const noop: FluidSimulation = {
    start() {},
    stop() {},
    resize() {},
    splat() {},
    dispose() {},
    supported: false,
  };
  const ctx = getWebGLContext(canvas);
  if (!ctx) return noop;
  const resources: SimulationResources = {
    textures: new Set(), framebuffers: new Set(), shaders: new Set(),
    programs: new Set(), buffers: new Set(),
  };
  try {
    return initSimulation(canvas, ctx, overrides, resources);
  } catch (err) {
    releaseSimulationResources(ctx.gl, resources);
    // Shader compile / FBO allocation can fail on restricted WebGL
    // drivers. If it does, we still want the Landing to render — just
    // without the fluid bloom — so we swallow and return a no-op sim.
    console.warn("Fluid sim failed to initialise:", err);
    return noop;
  }
}

type SimulationResources = {
  textures: Set<WebGLTexture>;
  framebuffers: Set<WebGLFramebuffer>;
  shaders: Set<WebGLShader>;
  programs: Set<WebGLProgram>;
  buffers: Set<WebGLBuffer>;
};

function releaseRenderTargets(gl: GL, resources: SimulationResources) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  for (const framebuffer of resources.framebuffers) gl.deleteFramebuffer(framebuffer);
  for (const texture of resources.textures) gl.deleteTexture(texture);
  resources.framebuffers.clear();
  resources.textures.clear();
}

function releaseSimulationResources(gl: GL, resources: SimulationResources) {
  releaseRenderTargets(gl, resources);
  gl.useProgram(null);
  for (const program of resources.programs) gl.deleteProgram(program);
  for (const shader of resources.shaders) gl.deleteShader(shader);
  for (const buffer of resources.buffers) gl.deleteBuffer(buffer);
  resources.programs.clear();
  resources.shaders.clear();
  resources.buffers.clear();
}

function initSimulation(
  canvas: HTMLCanvasElement,
  ctx: { gl: GL; ext: WebGLExt },
  overrides: Partial<Config>,
  resources: SimulationResources,
): FluidSimulation {
  const { gl, ext } = ctx;
  const config: Config = { ...DEFAULT_CONFIG, ...overrides };

  // Full-screen quad
  const vertexBuffer = gl.createBuffer();
  if (!vertexBuffer) throw new Error("vertex buffer create failed");
  resources.buffers.add(vertexBuffer);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  const indexBuffer = gl.createBuffer();
  if (!indexBuffer) throw new Error("index buffer create failed");
  resources.buffers.add(indexBuffer);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
  resources.shaders.add(vs);
  const mk = (frag: string) => {
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, frag);
    resources.shaders.add(fs);
    const program = linkProgram(gl, vs, fs);
    resources.programs.add(program);
    return { program, uniforms: getUniforms(gl, program) };
  };

  const clearProg = mk(FRAG_CLEAR);
  const splatProg = mk(FRAG_SPLAT);
  const advectionProg = mk(FRAG_ADVECTION);
  const divergenceProg = mk(FRAG_DIVERGENCE);
  const curlProg = mk(FRAG_CURL);
  const vorticityProg = mk(FRAG_VORTICITY);
  const pressureProg = mk(FRAG_PRESSURE);
  const gradientProg = mk(FRAG_GRADIENT);
  const displayProg = mk(FRAG_DISPLAY);

  const createFBO = (w: number, h: number, internalFormat: number, format: number, type: number, param: number): FBO => {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    if (!texture) throw new Error("texture create failed");
    resources.textures.add(texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("fbo create failed");
    resources.framebuffers.add(fbo);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const texelSizeX = 1 / w;
    const texelSizeY = 1 / h;
    return {
      texture,
      fbo,
      width: w,
      height: h,
      texelSizeX,
      texelSizeY,
      attach(id: number) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  };

  const createDoubleFBO = (w: number, h: number, internalFormat: number, format: number, type: number, param: number): DoubleFBO => {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w,
      height: h,
      texelSizeX: 1 / w,
      texelSizeY: 1 / h,
      get read() {
        return fbo1;
      },
      set read(v: FBO) {
        fbo1 = v;
      },
      get write() {
        return fbo2;
      },
      set write(v: FBO) {
        fbo2 = v;
      },
      swap() {
        const t = fbo1;
        fbo1 = fbo2;
        fbo2 = t;
      },
    };
  };

  const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

  let dye: DoubleFBO;
  let velocity: DoubleFBO;
  let divergence: FBO;
  let curl: FBO;
  let pressure: DoubleFBO;

  const initFramebuffers = () => {
    // Resizing replaces the simulation contents. Delete the old attachments
    // before allocating their replacements so window drags cannot grow VRAM.
    releaseRenderTargets(gl, resources);
    const simRes = getResolution(config.simResolution);
    const dyeRes = getResolution(config.dyeResolution);
    dye = createDoubleFBO(dyeRes.width, dyeRes.height, ext.formatRGBA.internalFormat, ext.formatRGBA.format, ext.halfFloatTexType, filtering);
    velocity = createDoubleFBO(simRes.width, simRes.height, ext.formatRG.internalFormat, ext.formatRG.format, ext.halfFloatTexType, filtering);
    divergence = createFBO(simRes.width, simRes.height, ext.formatR.internalFormat, ext.formatR.format, ext.halfFloatTexType, gl.NEAREST);
    curl = createFBO(simRes.width, simRes.height, ext.formatR.internalFormat, ext.formatR.format, ext.halfFloatTexType, gl.NEAREST);
    pressure = createDoubleFBO(simRes.width, simRes.height, ext.formatR.internalFormat, ext.formatR.format, ext.halfFloatTexType, gl.NEAREST);
  };

  const getResolution = (resolution: number) => {
    const aspect = Math.max(gl.drawingBufferWidth, 1) / Math.max(gl.drawingBufferHeight, 1);
    const ratio = aspect > 1 ? aspect : 1 / aspect;
    const min = Math.round(resolution);
    const max = Math.round(resolution * ratio);
    return aspect > 1 ? { width: max, height: min } : { width: min, height: max };
  };

  const blitTo = (target: FBO | null, clear = false) => {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    if (clear) gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  initFramebuffers();

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      initFramebuffers();
    }
  };

  type PendingSplat = {
    x: number;
    y: number;
    dx: number;
    dy: number;
    color: [number, number, number];
    radius: number;
  };
  const pending: PendingSplat[] = [];

  const splatPending = () => {
    if (pending.length === 0) return;
    const aspect = canvas.width / Math.max(canvas.height, 1);

    gl.useProgram(splatProg.program);
    for (const p of pending) {
      // Velocity splat
      gl.uniform1i(splatProg.uniforms.uTarget, velocity.read.attach(0));
      gl.uniform1f(splatProg.uniforms.aspectRatio, aspect);
      gl.uniform2f(splatProg.uniforms.point, p.x, p.y);
      gl.uniform3f(splatProg.uniforms.color, p.dx, p.dy, 0);
      gl.uniform1f(splatProg.uniforms.radius, correctRadius(p.radius, aspect));
      blitTo(velocity.write);
      velocity.swap();

      // Dye splat
      gl.uniform1i(splatProg.uniforms.uTarget, dye.read.attach(0));
      gl.uniform3f(splatProg.uniforms.color, p.color[0], p.color[1], p.color[2]);
      blitTo(dye.write);
      dye.swap();
    }
    pending.length = 0;
  };

  const correctRadius = (radius: number, aspect: number) => {
    if (aspect > 1) return radius * aspect;
    return radius;
  };

  let lastTime = performance.now();
  let running = false;

  const step = (dt: number) => {
    gl.disable(gl.BLEND);

    // Curl
    gl.useProgram(curlProg.program);
    gl.uniform2f(curlProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProg.uniforms.uVelocity, velocity.read.attach(0));
    blitTo(curl);

    // Vorticity confinement
    gl.useProgram(vorticityProg.program);
    gl.uniform2f(vorticityProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProg.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProg.uniforms.curl, config.curl);
    gl.uniform1f(vorticityProg.uniforms.dt, dt);
    blitTo(velocity.write);
    velocity.swap();

    // Divergence
    gl.useProgram(divergenceProg.program);
    gl.uniform2f(divergenceProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProg.uniforms.uVelocity, velocity.read.attach(0));
    blitTo(divergence);

    // Pressure decay + solve
    gl.useProgram(clearProg.program);
    gl.uniform1i(clearProg.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProg.uniforms.value, config.pressure);
    blitTo(pressure.write);
    pressure.swap();

    gl.useProgram(pressureProg.program);
    gl.uniform2f(pressureProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProg.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.pressureIterations; i++) {
      gl.uniform1i(pressureProg.uniforms.uPressure, pressure.read.attach(1));
      blitTo(pressure.write);
      pressure.swap();
    }

    // Gradient subtract
    gl.useProgram(gradientProg.program);
    gl.uniform2f(gradientProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientProg.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientProg.uniforms.uVelocity, velocity.read.attach(1));
    blitTo(velocity.write);
    velocity.swap();

    // Advect velocity
    gl.useProgram(advectionProg.program);
    gl.uniform2f(advectionProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform2f(advectionProg.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    const velId = velocity.read.attach(0);
    gl.uniform1i(advectionProg.uniforms.uVelocity, velId);
    gl.uniform1i(advectionProg.uniforms.uSource, velId);
    gl.uniform1f(advectionProg.uniforms.dt, dt);
    gl.uniform1f(advectionProg.uniforms.dissipation, config.velocityDissipation);
    blitTo(velocity.write);
    velocity.swap();

    // Advect dye
    gl.uniform2f(advectionProg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProg.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProg.uniforms.dissipation, config.densityDissipation);
    blitTo(dye.write);
    dye.swap();
  };

  const render = () => {
    // Enable alpha blending against the (transparent) framebuffer.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(displayProg.program);
    gl.uniform1i(displayProg.uniforms.uTexture, dye.read.attach(0));
    // Keep noise cells visually round: divide each axis by the shorter
    // dimension so the aspect ratio cancels out inside the shader.
    const bw = Math.max(gl.drawingBufferWidth, 1);
    const bh = Math.max(gl.drawingBufferHeight, 1);
    const m = Math.min(bw, bh);
    gl.uniform2f(displayProg.uniforms.uAspect, bw / m, bh / m);
    blitTo(null);
  };

  let rafId = 0;
  let disposed = false;
  const loop = () => {
    if (!running) return;
    const now = performance.now();
    const dtRaw = (now - lastTime) / 1000;
    lastTime = now;
    // Clamp dt (e.g. if tab was backgrounded) so re-entering doesn't
    // teleport all velocities through the whole grid in one step.
    const dt = Math.min(dtRaw, 1 / 30);
    resize();
    splatPending();
    step(dt);
    render();
    rafId = requestAnimationFrame(loop);
  };

  const api: FluidSimulation = {
    supported: true,
    start() {
      if (running || disposed) return;
      running = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },
    resize() {
      if (!disposed) resize();
    },
    splat(x, y, dx, dy, opts) {
      if (disposed) return;
      const color = opts?.color ?? [0.2, 0.53, 0.73];
      const radius = opts?.radius ?? 0.2;
      pending.push({
        x,
        y,
        dx: dx * config.splatForce,
        dy: dy * config.splatForce,
        color,
        radius: radius * radius * 0.0015 + 0.00005,
      });
    },
    dispose() {
      if (disposed) return;
      this.stop();
      disposed = true;
      pending.length = 0;
      // Delete owned objects, preserving the context: StrictMode immediately
      // creates another simulation on the same canvas. Losing that context
      // would make the remount's shader compilation fail.
      releaseSimulationResources(gl, resources);
    },
  };

  return api;
}
