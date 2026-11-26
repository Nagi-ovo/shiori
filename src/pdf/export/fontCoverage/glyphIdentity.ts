// ToUnicode may expand a typographic ligature. Compare identities without
// changing its label or equating unrelated compatibility characters.
const expandLigatures = (label:string) => label.replace(/[\uFB00-\uFB04]/gu, c => c.normalize('NFKC'));
export const sameGlyphUnicode = (left:string, right:string) => left === right || expandLigatures(left) === expandLigatures(right);
