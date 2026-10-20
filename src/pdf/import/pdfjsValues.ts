import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFObject, PDFString } from "pdf-lib";

// Readers for PDF values as pdf.js 5.6 reads them, shared by the annotation
// listing (./sourceAnnotations.ts) and its appearance parsing
// (./appearanceStream.ts).

export function lookup<T extends PDFObject>(
  dict: PDFDict,
  key: string,
  // pdf-lib's object classes have private constructors; instanceof only
  // needs the prototype.
  type: { prototype: T },
): T | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof (type as unknown as typeof PDFObject) ? (value as T) : undefined;
}

/** A PDF string's bytes as a JS string of char codes 0–255, as pdf.js holds it. */
export function latin1(value: PDFObject | undefined): string | undefined {
  if (!(value instanceof PDFString || value instanceof PDFHexString)) return undefined;
  const bytes = value.asBytes();
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

/**
 * pdf.js's getRgbColor on /C: no array → the black default, none → null,
 * 1 / 3 / 4 components → gray / RGB / CMYK, into a Uint8ClampedArray.
 */
export function rgbColor(
  value: PDFObject | undefined,
  fallback: Uint8ClampedArray | null = new Uint8ClampedArray(3),
): Uint8ClampedArray | null {
  if (!(value instanceof PDFArray)) return fallback;
  const components: number[] = [];
  for (let i = 0; i < value.size(); i += 1) {
    const item = value.lookup(i);
    components.push(item instanceof PDFNumber ? item.asNumber() : Number.NaN);
  }
  if (components.length === 0) return null;
  const rgb = fallback ?? new Uint8ClampedArray(3);
  if (components.length === 1) grayToRgb(components, rgb);
  else if (components.length === 3) rgbToRgb(components, rgb);
  else if (components.length === 4) cmykToRgb(components, rgb);
  return rgb;
}

export function grayToRgb(src: readonly number[], dest: Uint8ClampedArray): void {
  const c = src[0]! * 255;
  dest[0] = dest[1] = dest[2] = c;
}

export function rgbToRgb(src: readonly number[], dest: Uint8ClampedArray): void {
  dest[0] = src[0]! * 255;
  dest[1] = src[1]! * 255;
  dest[2] = src[2]! * 255;
}

/** pdf.js's DeviceCMYK polynomial (Apache-2.0, see THIRD_PARTY_NOTICES.md). */
export function cmykToRgb(src: readonly number[], dest: Uint8ClampedArray): void {
  const [c, m, y, k] = src as [number, number, number, number];
  dest[0] = 255 + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004) + m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) + k * (-21.86122147463605 * k - 189.48180835922747);
  dest[1] = 255 + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548) + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) + k * (-20.737325471181034 * k - 187.80453709719578);
  dest[2] = 255 + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286) + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) + y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) + k * (-22.33816807309886 * k - 180.12613974708367);
}
