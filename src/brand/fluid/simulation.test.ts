import { afterEach, describe, expect, test } from "bun:test";
import { createFluidSimulation } from "./simulation";

const originals = new Map(["window", "requestAnimationFrame", "cancelAnimationFrame"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
));
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function gpuFixture(failure?: "shader" | "texture") {
  const live = new Map<string, Set<object>>();
  const constants = new Map<string, number>();
  const frames = new Set<number>();
  let frameId = 0;
  let shaderCount = 0;
  let textureCount = 0;
  let lost = false;
  const canvas = { width: 300, height: 150, clientWidth: 320, clientHeight: 200, getContext: () => gl };
  const gl = new Proxy({} as Record<string, unknown>, {
    get: (_, key: string): unknown => {
      if (key === "drawingBufferWidth") return canvas.width;
      if (key === "drawingBufferHeight") return canvas.height;
      if (/^[A-Z][A-Z_0-9]+$/.test(key)) {
        if (!constants.has(key)) constants.set(key, constants.size + 1);
        return constants.get(key);
      }
      if (key.startsWith("create")) return () => {
        const kind = key.slice(6);
        if (kind === "Texture" && ++textureCount === 7 && failure === "texture") return null;
        const object = {};
        if (!live.has(kind)) live.set(kind, new Set());
        live.get(kind)!.add(object);
        return object;
      };
      if (key.startsWith("delete")) return (object: object) => live.get(key.slice(6))?.delete(object);
      if (key === "getExtension") return (name: string) => name === "WEBGL_lose_context"
        ? { loseContext: () => { lost = true; } } : {};
      if (key === "getShaderParameter") return () => !(++shaderCount === 3 && failure === "shader");
      if (key === "getProgramParameter") return (_: unknown, parameter: number) => parameter === gl.LINK_STATUS;
      if (key === "checkFramebufferStatus") return () => gl.FRAMEBUFFER_COMPLETE;
      return () => undefined;
    },
  });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { devicePixelRatio: 1 } },
    requestAnimationFrame: { configurable: true, value: () => { frames.add(++frameId); return frameId; } },
    cancelAnimationFrame: { configurable: true, value: (id: number) => frames.delete(id) },
  });
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    setWidth: (width: number) => { canvas.clientWidth = width; },
    count: (kind: string) => live.get(kind)?.size ?? 0,
    total: () => [...live.values()].reduce((sum, objects) => sum + objects.size, 0),
    frames,
    contextLost: () => lost,
  };
}

describe("fluid simulation GPU lifetime", () => {
  test("bounds render targets through repeated window resizes", () => {
    const gpu = gpuFixture();
    const simulation = createFluidSimulation(gpu.canvas);
    expect(simulation.supported).toBe(true);
    for (let i = 0; i < 6; i++) {
      gpu.setWidth(320 + i * 17);
      simulation.resize();
      expect(gpu.count("Texture")).toBe(8);
      expect(gpu.count("Framebuffer")).toBe(8);
    }
    simulation.dispose();
    expect(gpu.total()).toBe(0);
  });

  test("disposes all resources and remounts on the same live context", () => {
    const gpu = gpuFixture();
    const simulation = createFluidSimulation(gpu.canvas);
    simulation.start();
    expect(gpu.frames.size).toBe(1);
    simulation.dispose();
    simulation.dispose();
    expect(gpu.frames.size).toBe(0);
    expect(gpu.total()).toBe(0);
    expect(gpu.contextLost()).toBe(false);
    simulation.start();
    expect(gpu.frames.size).toBe(0);
    const remount = createFluidSimulation(gpu.canvas);
    expect(remount.supported).toBe(true);
    remount.dispose();
    expect(gpu.total()).toBe(0);
  });

  for (const failure of ["shader", "texture"] as const) {
    test(`releases partial allocations when ${failure} initialization fails`, () => {
      const gpu = gpuFixture(failure);
      expect(createFluidSimulation(gpu.canvas).supported).toBe(false);
      expect(gpu.total()).toBe(0);
      expect(gpu.contextLost()).toBe(false);
    });
  }
});
