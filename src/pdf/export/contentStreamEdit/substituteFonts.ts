import { resolveFont } from '../fonts/fontService';

export function substituteFontName(baseFont: string, flags: number, text: string): string {
  return resolveFont({ purpose: 'run-substitute', baseFont, flags, text }).name;
}
