import type { Font } from '@pdf-lib/fontkit';

type FontOs2 = {
  version: number;
  fsType?: {
    noEmbedding: boolean;
    viewOnly: boolean;
    editable: boolean;
    noSubsetting: boolean;
    bitmapOnly: boolean;
  };
  codePageRange?: number[];
  usWeightClass?: number;
  fsSelection?: { bold: boolean; italic: boolean; oblique: boolean };
};

type FontWithOs2 = {
  'OS/2'?: FontOs2;
  directory?: { tables: { 'OS/2'?: { length: number } } };
};

const os2MinimumLength = [68, 86, 96, 96, 96, 100];

export function fontOs2(font: Font): FontOs2 | undefined {
  const parsed = font as unknown as FontWithOs2;
  const os2 = parsed['OS/2'];
  const length = parsed.directory?.tables['OS/2']?.length;
  // Fontkit may decode fields beyond the table's declared boundary.
  if (os2 && length !== undefined && length < (os2MinimumLength[os2.version] ?? Infinity)) return undefined;
  return os2;
}

export function allowsSubsetEmbedding(os2: FontOs2 | undefined): boolean {
  const permission = os2?.fsType;
  return !!permission && !permission.noEmbedding && !permission.noSubsetting && !permission.bitmapOnly &&
    (!permission.viewOnly || permission.editable);
}
