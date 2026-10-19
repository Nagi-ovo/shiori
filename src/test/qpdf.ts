/**
 * qpdf as the independent reader for tests that verify Shiori's own writer
 * (exportPdf, page insertion, re-encryption): a PDF Shiori writes is checked
 * by code Shiori did not write. PDFium reads it back too, but PDFium is also
 * what decrypts and re-encrypts, so it cannot be the only witness.
 *
 * Locally qpdf is optional (`brew install qpdf`): without it the tests that
 * need it show as skipped. ci.yml installs it and sets SHIORI_REQUIRE_QPDF,
 * so there a missing qpdf fails the run instead of skipping the gate.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

export const QPDF: string | null = Bun.which("qpdf");
if (!QPDF && process.env.SHIORI_REQUIRE_QPDF) {
  throw new Error("SHIORI_REQUIRE_QPDF is set but qpdf is not installed: the writer tests need it");
}

/** A test that runs only where qpdf is installed, and shows as skipped elsewhere. */
export const qpdfTest = test.skipIf(!QPDF);

export type QpdfRun = { code: number; stdout: string; stderr: string };

/** Runs qpdf on `bytes`, written to a temporary file; `args` come before the file. */
export function qpdf(bytes: Uint8Array, args: string[], password?: string): QpdfRun {
  if (!QPDF) throw new Error("qpdf is not installed");
  const dir = mkdtempSync(join(tmpdir(), "shiori-qpdf-"));
  try {
    const file = join(dir, "in.pdf");
    writeFileSync(file, bytes);
    const passwordArgs = password === undefined ? [] : [`--password=${password}`];
    const run = Bun.spawnSync([QPDF, ...passwordArgs, ...args, file], { stdout: "pipe", stderr: "pipe" });
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when qpdf refuses to open `bytes` with `password` (exit 2, "invalid password"). */
export function qpdfRejectsPassword(bytes: Uint8Array, password?: string): boolean {
  const run = qpdf(bytes, ["--check"], password);
  return run.code === 2 && /invalid password/.test(run.stderr);
}

/**
 * The structural check: xref, object streams and every stream decode.
 * Exit 0 is clean, 3 is warnings only; both mean qpdf read the whole file.
 */
export function qpdfCheck(bytes: Uint8Array, password?: string): QpdfRun {
  return qpdf(bytes, ["--check"], password);
}

/**
 * The security handler qpdf reads: revision, permissions and crypt methods,
 * without the line naming which password was supplied.
 */
export function qpdfEncryption(bytes: Uint8Array, password?: string): string {
  const run = qpdf(bytes, ["--show-encryption"], password);
  if (run.code !== 0) throw new Error(`qpdf --show-encryption failed: ${run.stderr}`);
  return run.stdout
    .split("\n")
    .filter((line) => !line.startsWith("Supplied password is"))
    .join("\n");
}

type QpdfValue = string | number | boolean | null | QpdfValue[] | { [key: string]: QpdfValue };
type QpdfObject = { value?: QpdfValue; stream?: { dict: Record<string, QpdfValue>; data?: string } };

/** A PDF as qpdf reads it (decrypted with `password`), with references resolved on demand. */
export class QpdfDocument {
  private readonly objects: Record<string, QpdfObject>;

  private constructor(objects: Record<string, QpdfObject>) {
    this.objects = objects;
  }

  static open(bytes: Uint8Array, password?: string): QpdfDocument {
    const run = qpdf(bytes, ["--json=2", "--json-key=qpdf", "--json-stream-data=inline"], password);
    if (run.code !== 0 && run.code !== 3) throw new Error(`qpdf --json failed: ${run.stderr}`);
    const [, objects] = (JSON.parse(run.stdout) as { qpdf: [unknown, Record<string, QpdfObject>] }).qpdf;
    return new QpdfDocument(objects);
  }

  /** Follows `value` while it is an indirect reference ("12 0 R"). */
  resolve(value: QpdfValue | undefined): QpdfValue | undefined {
    let current = value;
    for (let hops = 0; typeof current === "string" && /^\d+ \d+ R$/.test(current) && hops < 32; hops += 1) {
      const target: QpdfObject | undefined = this.objects[`obj:${current}`];
      if (!target) return undefined;
      current = target.value ?? (target.stream?.dict as QpdfValue | undefined);
    }
    return current;
  }

  dict(value: QpdfValue | undefined): Record<string, QpdfValue> {
    const resolved = this.resolve(value);
    return resolved && typeof resolved === "object" && !Array.isArray(resolved) ? resolved : {};
  }

  array(value: QpdfValue | undefined): QpdfValue[] {
    const resolved = this.resolve(value);
    return Array.isArray(resolved) ? resolved : [];
  }

  /** A text string's value ("u:…"), or null for anything else. */
  text(value: QpdfValue | undefined): string | null {
    const resolved = this.resolve(value);
    return typeof resolved === "string" && resolved.startsWith("u:") ? resolved.slice(2) : null;
  }

  /** A stream's decoded bytes. */
  streamData(ref: QpdfValue | undefined): Uint8Array | null {
    if (typeof ref !== "string") return null;
    const data = this.objects[`obj:${ref}`]?.stream?.data;
    return data === undefined ? null : new Uint8Array(Buffer.from(data, "base64"));
  }

  get trailer(): Record<string, QpdfValue> {
    return (this.objects.trailer?.value as Record<string, QpdfValue> | undefined) ?? {};
  }

  get catalog(): Record<string, QpdfValue> {
    return this.dict(this.trailer["/Root"]);
  }

  get info(): Record<string, QpdfValue> {
    return this.dict(this.trailer["/Info"]);
  }

  /** Page dictionaries in order, walking /Kids from the catalog's /Pages. */
  pages(): Record<string, QpdfValue>[] {
    const out: Record<string, QpdfValue>[] = [];
    const walk = (node: QpdfValue | undefined) => {
      const dict = this.dict(node);
      if (dict["/Type"] === "/Pages") for (const kid of this.array(dict["/Kids"])) walk(kid);
      else out.push(dict);
    };
    walk(this.catalog["/Pages"]);
    return out;
  }

  /** Each annotation dictionary on page `index`. */
  annotations(index: number): Record<string, QpdfValue>[] {
    return this.array(this.pages()[index]?.["/Annots"]).map((annot) => this.dict(annot));
  }

  /** Embedded files by name, from the /EmbeddedFiles name tree. */
  attachments(): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    const walk = (node: QpdfValue | undefined) => {
      const dict = this.dict(node);
      for (const kid of this.array(dict["/Kids"])) walk(kid);
      const names = this.array(dict["/Names"]);
      for (let i = 0; i + 1 < names.length; i += 2) {
        const name = this.text(names[i]);
        const file = this.dict(this.dict(names[i + 1])["/EF"])["/F"];
        const data = this.streamData(file);
        if (name !== null && data) out[name] = data;
      }
    };
    walk(this.dict(this.catalog["/Names"])["/EmbeddedFiles"]);
    return out;
  }

  /** The catalog's XMP metadata stream, decoded, as text. */
  xmp(): string | null {
    const data = this.streamData(this.catalog["/Metadata"]);
    return data ? new TextDecoder().decode(data) : null;
  }
}
