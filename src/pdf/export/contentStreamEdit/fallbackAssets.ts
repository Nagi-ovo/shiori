// These exact files already ship through DOCX defaultFonts. Explicit lazy
// imports reuse Vite's existing asset URLs without adding another font copy.
const metricUrls: Record<string, () => Promise<{ default: string }>> = {
  'LiberationSans-Regular.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf?url'),
  'LiberationSans-Bold.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Bold.ttf?url'),
  'LiberationSans-Italic.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Italic.ttf?url'),
  'LiberationSans-BoldItalic.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationSans-BoldItalic.ttf?url'),
  'LiberationSerif-Regular.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-Regular.ttf?url'),
  'LiberationSerif-Bold.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-Bold.ttf?url'),
  'LiberationSerif-Italic.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-Italic.ttf?url'),
  'LiberationSerif-BoldItalic.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-BoldItalic.ttf?url'),
  'LiberationMono-Regular.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationMono-Regular.ttf?url'),
  'LiberationMono-Bold.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationMono-Bold.ttf?url'),
  'LiberationMono-Italic.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationMono-Italic.ttf?url'),
  'LiberationMono-BoldItalic.ttf': () => import('../../../../node_modules/@docx-editor.dev/fonts/assets/LiberationMono-BoldItalic.ttf?url'),
};
export async function fallbackFontUrl(name: string): Promise<string> {
  if (metricUrls[name]) return (await metricUrls[name]()).default;
  const { cjkScExportFontUrl, cjkJpExportFontUrl } = await import('../fontAssets');
  if (name === 'NotoSansSC-Regular.otf') return cjkScExportFontUrl;
  if (name === 'NotoSansJP-Regular.otf') return cjkJpExportFontUrl;
  throw Error('bundled fallback font unavailable');
}
const bytesByName = new Map<string, Promise<Uint8Array>>();
export function loadBundledFallbackFont(name: string): Promise<Uint8Array> {
  let pending = bytesByName.get(name);
  if (!pending) {
    pending = fallbackFontUrl(name).then(async url => {
      const response = await fetch(url);
      if (!response.ok) throw Error('could not load fallback font');
      return new Uint8Array(await response.arrayBuffer());
    }).catch(error => { bytesByName.delete(name); throw error; });
    bytesByName.set(name, pending);
  }
  return pending;
}
