"""Native PDFium read/render oracle; no GenerateContent or PDFium writer calls.
Run via bun scripts/pdf-inplace/surgical-first.ts. ABI from vendor headers.
"""
import ctypes as C
import hashlib
import json
import math
import pathlib
import subprocess
import sys

P, I, D, U, Z = C.c_void_p, C.c_int, C.c_double, C.c_uint, C.c_size_t
lib = C.CDLL(sys.argv[1])
def bind(name, result, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, args
    return fn
init = bind('FPDF_InitLibrary', None)
load = bind('FPDF_LoadMemDocument64', P, P, Z, C.c_char_p)
close_doc = bind('FPDF_CloseDocument', None, P)
load_page = bind('FPDF_LoadPage', P, P, I)
close_page = bind('FPDF_ClosePage', None, P)
load_text = bind('FPDFText_LoadPage', P, P)
close_text = bind('FPDFText_ClosePage', None, P)
count = bind('FPDFText_CountChars', I, P)
get_unicode = bind('FPDFText_GetUnicode', U, P, I)
generated = bind('FPDFText_IsGenerated', I, P, I)
origin = bind('FPDFText_GetCharOrigin', I, P, I, C.POINTER(D), C.POINTER(D))
get_obj = bind('FPDFText_GetTextObject', P, P, I)
get_font = bind('FPDFTextObj_GetFont', P, P)
font_data = bind('FPDFFont_GetFontData', I, P, P, Z, C.POINTER(Z))
embedded = bind('FPDFFont_GetIsEmbedded', I, P)
bitmap_create = bind('FPDFBitmap_CreateEx', P, I, I, I, P, I)
fill = bind('FPDFBitmap_FillRect', I, P, I, I, I, I, C.c_ulong)
render = bind('FPDF_RenderPageBitmap', None, P, P, I, I, I, I, I, I)
bitmap_destroy = bind('FPDFBitmap_Destroy', None, P)
get_width = bind('FPDF_GetPageWidthF', C.c_float, P)
get_height = bind('FPDF_GetPageHeightF', C.c_float, P)
init()


def measure(path, specs, font_hashes):
    data = C.create_string_buffer(path.read_bytes())
    doc = load(data, len(data.raw) - 1, None)
    assert doc, f'PDFium open failed: {path}'
    page = load_page(doc, 0)
    text = load_text(page)
    glyphs, generated_chars, all_text = [], [], []
    font_ids, reverse_ids, hashes = {}, {}, {}
    for i in range(count(text)):
        unicode = chr(get_unicode(text, i))
        all_text.append(unicode)
        is_generated = generated(text, i)
        source_match = bool(get_obj(text, i)) and len(glyphs) < len(specs) and specs[len(glyphs)]['unicode'] == unicode
        if is_generated:
            assert unicode in '\r\n ', f'unexpected generated char {unicode!r}'
            generated_chars.append({'index': i, 'unicode': unicode, 'matchedSource': source_match})
            if not source_match:
                continue
        assert len(glyphs) < len(specs), f'extra native glyph {unicode!r} at {i}: {path}'
        spec = specs[len(glyphs)]
        assert spec['unicode'] == unicode, f'code/Unicode mismatch {spec} vs {unicode!r}: {path}'
        obj = get_obj(text, i)
        assert obj, f'source glyph has no text object: {i}'
        font = get_font(obj)
        assert font and embedded(font) == 1, 'fixture must use embedded fonts'
        identity = spec['fontObject']
        assert font_ids.setdefault(identity, font) == font, 'source font object split'
        assert reverse_ids.setdefault(font, identity) == identity, 'distinct source fonts collapsed'
        if font not in hashes:
            size = Z()
            assert font_data(font, None, 0, C.byref(size))
            buf = C.create_string_buffer(size.value)
            assert font_data(font, buf, size, C.byref(size))
            hashes[font] = hashlib.sha256(buf.raw).hexdigest()
        assert hashes[font] == font_hashes[identity], f'font program mismatch for {identity}'
        x, y = D(), D()
        assert origin(text, i, C.byref(x), C.byref(y))
        glyphs.append({**spec, 'origin': [x.value, y.value], 'nativeIndex': i, 'nativeGenerated': bool(is_generated)})
    assert len(glyphs) == len(specs), f'unaccounted source glyphs: {len(glyphs)}/{len(specs)} in {path}'
    width, height = round(get_width(page) * 2), round(get_height(page) * 2)
    raster = C.create_string_buffer(width * height * 4)
    bitmap = bitmap_create(width, height, 4, raster, width * 4)
    assert bitmap
    fill(bitmap, 0, 0, width, height, 0xffffffff)
    render(bitmap, page, 0, 0, width, height, 0, 0)  # 144dpi, BGRA, flags=0
    pixels = raster.raw
    # Portable RGB raster artifact, no image library dependency.
    rgb = bytearray()
    for i in range(0, len(pixels), 4):
        rgb.extend((pixels[i + 2], pixels[i + 1], pixels[i]))
    path.with_suffix('.ppm').write_bytes(f'P6\n{width} {height}\n255\n'.encode() + rgb)
    bitmap_destroy(bitmap)
    close_text(text)
    close_page(page)
    close_doc(doc)
    return {'glyphs': glyphs, 'generated': generated_chars, 'text': ''.join(all_text),
            'width': width, 'height': height}, pixels


out = pathlib.Path(sys.argv[2])
if len(sys.argv) > 3 and sys.argv[3] == '--preview':
    page_count = bind('FPDF_GetPageCount', I, P)
    checks = []
    for name in ['preview-300.before.pdf', 'preview-300.full.pdf', 'preview-300.incremental.pdf']:
        data = C.create_string_buffer((out / name).read_bytes())
        doc = load(data, len(data.raw) - 1, None)
        assert doc and page_count(doc) == 300
        texts = []
        for index in [0, 299]:
            page = load_page(doc, index)
            text = load_text(page)
            value = ''.join(chr(get_unicode(text, i)) for i in range(count(text)))
            assert ('Hello World' if index == 299 or 'before' in name else 'Hello') in value
            if index == 0 and 'before' not in name:
                assert 'Hello World' not in value
            texts.append(value)
            close_text(text)
            close_page(page)
        close_doc(doc)
        checks.append({'file': name, 'pages': 300, 'firstAndLastText': texts, 'passed': True})
    (out / 'preview-native.json').write_text(json.dumps(checks, indent=2))
    print(json.dumps(checks))
    sys.exit(0)

manifest = json.loads((out / 'manifest.json').read_text())
rows = []
for case in manifest:
    before_path, after_path = out / case['before'], out / case['after']
    before, a = measure(before_path, case['beforeGlyphs'], case['fontHashes'])
    after, b = measure(after_path, case['afterGlyphs'], case['fontHashes'])
    old = [g for g in before['glyphs'] if not g['edited']]
    new = [g for g in after['glyphs'] if not g['edited']]
    assert len(old) == len(new)
    drift = 0
    ordinals = {}
    for x, y in zip(old, new):
        key = (x['fontObject'], x['code'])
        order = ordinals.get(key, 0)
        ordinals[key] = order + 1
        assert key == (y['fontObject'], y['code']), f'untouched code/order changed at {key}/{order}'
        drift = max(drift, math.dist(x['origin'], y['origin']))
    assert drift <= .01, f'neighbour drift {drift}: {case["name"]}'
    assert len(a) == len(b)
    outside, total = 0, 0
    left, bottom, right, top = case['editBox']
    for i in range(0, len(a), 4):
        if a[i:i+4] == b[i:i+4]:
            continue
        total += 1
        x, y = (i // 4) % before['width'], (i // 4) // before['width']
        # Declared PDF box, rasterized at 2 pixels/pt; exact channel diff.
        if not (left * 2 <= x < right * 2 and (before['height'] - top * 2) <= y < (before['height'] - bottom * 2)):
            outside += 1
    assert outside == 0, f'{outside} changed pixels outside declared box: {case["name"]}'
    if not any(g['edited'] for g in before['glyphs']):
        assert total == 0, f'identity changed raster: {case["name"]}'
    poppler = subprocess.check_output(['pdftotext', '-layout', str(after_path), '-']).decode()
    for needle in case['required']:
        assert needle in after['text'] and needle in poppler, f'missing {needle!r}: {case["name"]}'
    for needle in case['absent']:
        assert needle not in after['text'] and needle not in poppler, f'old text active {needle!r}'
    check = subprocess.run(['qpdf', '--check', str(after_path)], capture_output=True, text=True)
    assert check.returncode == 0, check.stdout + check.stderr
    after_path.with_suffix('.txt').write_text(poppler)
    row = {'name': case['name'], 'sourceGlyphs': len(before['glyphs']),
           'editedSourceGlyphs': len(before['glyphs']) - len(old), 'untouchedGlyphs': len(old),
           'outputGlyphs': len(after['glyphs']), 'maxOriginDriftPt': drift,
           'changedPixels': total, 'changedPixelsOutsideBox': outside, 'editBox': case['editBox'],
           'fontObjects': sorted(case['fontHashes']), 'PDFiumText': after['text'],
           'pdftotext': poppler, 'qpdf': 'clean', 'passed': True}
    # Include every glyph and every explicitly generated character for audit.
    (out / f'{case["name"]}.glyphs.json').write_text(json.dumps({'before': before, 'after': after}, indent=2))
    rows.append(row)
    print(json.dumps(row))
(out / 'report.json').write_text(json.dumps({'nativeLibrary': str(pathlib.Path(sys.argv[1]).resolve()),
    'raster': {'dpi': 144, 'format': 'BGRA', 'flags': 0, 'channelTolerance': 0}, 'cases': rows}, indent=2))
