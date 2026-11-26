// Synthetic Private dictionary entries for the conditional stem-hint grammar.
function conditionalHints(axis: 'H' | 'V', preferred: number[], fallback: number[]) {
  const dictionary = ['systemdict', '/internaldict'];
  return [
    `/StemSnap${axis} [${preferred.join(' ')}]`,
    [...dictionary, 'known'].join(' '),
    '{',
    [1_183_615_869, ...dictionary, 'get', 'exec'].join(' '),
    '  /StemSnapLength 2 copy known',
    `  { get ${preferred.length} lt } { pop pop true } ifelse`,
    '} { true } ifelse',
    `{ pop [${fallback.join(' ')}] } if def`,
  ].join('\n');
}

export const stemSnapHints = conditionalHints('H', [12, 27, 51], [15, 29]);
export const verticalStemSnapHints = conditionalHints('V', [8, 16, 34, 45, 57], [9]);
