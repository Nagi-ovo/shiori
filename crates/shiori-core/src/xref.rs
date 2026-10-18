//! Where a file's objects are, as its cross-reference sections say: from the
//! last `startxref` through each classic table or cross-reference stream
//! and its /Prev, a hybrid file's /XRefStm included, the newest section
//! winning. The re-encryption reads the source's /Encrypt and /ID here, so
//! it takes the handler PDFium took. An object is read only at the offset a
//! section gives and only if `num gen obj` stands there; whatever cannot be
//! followed that way is refused, never searched for in the text, where a
//! comment, a stale revision or a PDF embedded in a stream can spell out
//! another one.

use std::collections::{HashMap, HashSet};

use crate::pdf_syntax::{decode_name, is_delimiter, is_whitespace, Dict, Object, Parser};

/// How many cross-reference sections a file may chain through /Prev.
const MAX_SECTIONS: usize = 256;
/// How far a cross-reference stream may inflate.
const MAX_STREAM: usize = 1 << 28;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Entry {
    Free,
    InUse {
        offset: u64,
        gen: u16,
    },
    /// In an object stream, which /Encrypt never is (§7.5.7).
    Compressed,
}

/// One section's entries and its trailer (or stream dictionary).
type Section = (Vec<(u32, Entry)>, Dict);

/// A file's cross-reference, read once.
pub struct CrossReference<'a> {
    source: &'a [u8],
    /// Where `%PDF-` begins: PDFium counts offsets from there.
    base: usize,
    entries: HashMap<u32, Entry>,
    /// Newest first.
    trailers: Vec<Dict>,
}

impl<'a> CrossReference<'a> {
    pub fn read(source: &'a [u8]) -> Result<Self, &'static str> {
        let head = &source[..source.len().min(1024)];
        let base = head
            .windows(5)
            .position(|w| w == b"%PDF-")
            .ok_or("no %PDF- header")?;
        let mut xref = CrossReference {
            source,
            base,
            entries: HashMap::new(),
            trailers: Vec::new(),
        };
        let mut next = Some(xref.startxref()?);
        let mut seen = HashSet::new();
        while let Some(offset) = next {
            if !seen.insert(offset) {
                return Err("a /Prev loop in the cross-reference");
            }
            if seen.len() > MAX_SECTIONS {
                return Err("too many cross-reference sections");
            }
            let (section, trailer) = xref.section(offset)?;
            for (num, entry) in section {
                xref.entries.entry(num).or_insert(entry);
            }
            next = match trailer.get("Prev") {
                None => None,
                Some(prev) => Some(
                    prev.as_int()
                        .and_then(|prev| u64::try_from(prev).ok())
                        .ok_or("a /Prev that is not an offset")?,
                ),
            };
            xref.trailers.push(trailer);
        }
        Ok(xref)
    }

    /// The offset after the file's last `startxref` keyword.
    fn startxref(&self) -> Result<u64, &'static str> {
        let source = self.source;
        let at = source
            .windows(9)
            .enumerate()
            .rev()
            .find(|&(at, window)| {
                window == b"startxref"
                    && (at == 0 || is_whitespace(source[at - 1]) || is_delimiter(source[at - 1]))
                    && source
                        .get(at + 9)
                        .is_none_or(|&b| is_whitespace(b) || is_delimiter(b))
            })
            .map(|(at, _)| at)
            .ok_or("no startxref")?;
        let mut parser = Parser::new(source, at + 9);
        parser.skip_whitespace();
        parser.unsigned().ok_or("startxref gives no offset")
    }

    /// Where `offset` (counted from the header) lies in the file.
    fn position(&self, offset: u64) -> Result<usize, &'static str> {
        usize::try_from(offset)
            .ok()
            .and_then(|offset| offset.checked_add(self.base))
            .filter(|&at| at < self.source.len())
            .ok_or("an offset past the end of the file")
    }

    /// The entries and trailer of the section at `offset`: a classic table
    /// (with its /XRefStm) or a cross-reference stream.
    fn section(&self, offset: u64) -> Result<Section, &'static str> {
        let at = self.position(offset)?;
        let mut parser = Parser::new(self.source, at);
        parser.skip_whitespace();
        if !parser.at_keyword(b"xref") {
            return self.stream_section(at);
        }
        parser.pos += 4;
        let (mut used, mut free) = (Vec::new(), Vec::new());
        loop {
            parser.skip_whitespace();
            if parser.at_keyword(b"trailer") {
                parser.pos += 7;
                break;
            }
            let bad = "a malformed cross-reference table";
            let start = parser.unsigned().ok_or(bad)?;
            parser.skip_whitespace();
            let count = parser.unsigned().ok_or(bad)?;
            for index in 0..count {
                let num = start
                    .checked_add(index)
                    .and_then(|num| u32::try_from(num).ok())
                    .ok_or(bad)?;
                parser.skip_whitespace();
                let field = parser.unsigned().ok_or(bad)?;
                parser.skip_whitespace();
                let gen = parser.unsigned().and_then(|g| u16::try_from(g).ok());
                let gen = gen.ok_or(bad)?;
                parser.skip_whitespace();
                match parser.token() {
                    b"n" => used.push((num, Entry::InUse { offset: field, gen })),
                    b"f" => free.push((num, Entry::Free)),
                    _ => return Err(bad),
                }
            }
        }
        parser.skip_whitespace();
        let Ok(Object::Dict(trailer)) = parser.object() else {
            return Err("a trailer that is not a dictionary");
        };
        // A hybrid file lists in its stream what the table marks free;
        // the table's own in-use entries come first (§7.5.8.4).
        if let Some(stream) = trailer.get("XRefStm") {
            let stream = stream
                .as_int()
                .and_then(|offset| u64::try_from(offset).ok())
                .ok_or("an /XRefStm that is not an offset")?;
            let (hidden, _) = self.stream_section(self.position(stream)?)?;
            used.extend(hidden);
        }
        used.extend(free);
        Ok((used, trailer))
    }

    fn stream_section(&self, at: usize) -> Result<Section, &'static str> {
        let bad = "no cross-reference section where startxref or /Prev points";
        let mut parser = Parser::new(self.source, at);
        parser.skip_whitespace();
        parser.unsigned().ok_or(bad)?;
        parser.skip_whitespace();
        parser.unsigned().ok_or(bad)?;
        parser.expect_keyword(b"obj").map_err(|_| bad)?;
        let Ok(Object::Dict(dict)) = parser.object() else {
            return Err(bad);
        };
        if dict.name("Type").as_deref() != Some(b"XRef") {
            return Err(bad);
        }
        parser.expect_keyword(b"stream").map_err(|_| bad)?;
        if self.source.get(parser.pos) == Some(&b'\r') {
            parser.pos += 1;
        }
        if self.source.get(parser.pos) == Some(&b'\n') {
            parser.pos += 1;
        }
        let length = dict
            .get("Length")
            .and_then(Object::as_int)
            .and_then(|length| usize::try_from(length).ok())
            .ok_or("a cross-reference stream without a direct /Length")?;
        let raw = parser
            .pos
            .checked_add(length)
            .and_then(|end| self.source.get(parser.pos..end))
            .ok_or("a cross-reference stream past the end of the file")?;
        let data = decode(&dict, raw)?;

        let widths = match dict.get("W") {
            Some(Object::Array(items)) if items.len() == 3 => items
                .iter()
                .map(|w| {
                    w.as_int()
                        .and_then(|w| usize::try_from(w).ok())
                        .filter(|&w| w <= 8)
                })
                .collect::<Option<Vec<_>>>(),
            _ => None,
        }
        .ok_or("a cross-reference stream with a bad /W")?;
        let row = widths.iter().sum::<usize>();
        if row == 0 {
            return Err("a cross-reference stream with a bad /W");
        }
        let size = dict
            .int("Size")
            .and_then(|size| u64::try_from(size).ok())
            .ok_or("a cross-reference stream without /Size")?;
        let index = match dict.get("Index") {
            None => vec![0, size],
            Some(Object::Array(items)) if items.len() % 2 == 0 => items
                .iter()
                .map(|n| n.as_int().and_then(|n| u64::try_from(n).ok()))
                .collect::<Option<Vec<_>>>()
                .ok_or("a cross-reference stream with a bad /Index")?,
            _ => return Err("a cross-reference stream with a bad /Index"),
        };
        let rows: u64 = index
            .chunks(2)
            .map(|pair| pair[1])
            .try_fold(0u64, |sum, n| sum.checked_add(n))
            .ok_or("a cross-reference stream with a bad /Index")?;
        if rows
            .checked_mul(row as u64)
            .is_none_or(|need| need > data.len() as u64)
        {
            return Err("a cross-reference stream shorter than its /Index");
        }
        let mut entries = Vec::new();
        let mut fields = data.chunks_exact(row);
        for pair in index.chunks(2) {
            for index in 0..pair[1] {
                let num = pair[0]
                    .checked_add(index)
                    .and_then(|num| u32::try_from(num).ok())
                    .ok_or("a cross-reference stream with a bad /Index")?;
                let bytes = fields
                    .next()
                    .ok_or("a cross-reference stream shorter than its /Index")?;
                let (kind, rest) = bytes.split_at(widths[0]);
                let (second, third) = rest.split_at(widths[1]);
                let number =
                    |bytes: &[u8]| bytes.iter().fold(0u64, |n, &b| (n << 8) | u64::from(b));
                let kind = if widths[0] == 0 { 1 } else { number(kind) };
                entries.push((
                    num,
                    match kind {
                        1 => Entry::InUse {
                            offset: number(second),
                            gen: u16::try_from(number(third))
                                .map_err(|_| "a generation out of range")?,
                        },
                        2 => Entry::Compressed,
                        // Type 0, and any other, is the null object.
                        _ => Entry::Free,
                    },
                ));
            }
        }
        Ok((entries, dict))
    }
    /// A trailer entry: the newest section's, else the newest older one
    /// that has it, as PDFium merges an update's trailer into the last.
    pub fn trailer(&self, key: &str) -> Option<&Object> {
        self.trailers.iter().find_map(|trailer| trailer.get(key))
    }

    /// `object`, read through the cross-reference when it is a reference.
    pub fn resolve(&self, object: &Object) -> Result<Object, &'static str> {
        match object {
            Object::Ref(num, gen) => self.object(*num, *gen),
            other => Ok(other.clone()),
        }
    }

    /// The value of object `num gen`, from where the cross-reference says it is.
    pub fn object(&self, num: u32, gen: u16) -> Result<Object, &'static str> {
        let offset = match self.entries.get(&num) {
            Some(Entry::InUse {
                offset,
                gen: listed,
            }) if *listed == gen => *offset,
            Some(Entry::InUse { .. }) => return Err("an object under another generation"),
            Some(Entry::Compressed) => return Err("an object inside an object stream"),
            Some(Entry::Free) | None => return Err("an object the cross-reference does not list"),
        };
        let mut parser = Parser::new(self.source, self.position(offset)?);
        parser.skip_whitespace();
        let found_num = parser.unsigned();
        parser.skip_whitespace();
        let found_gen = parser.unsigned();
        if found_num != Some(u64::from(num)) || found_gen != Some(u64::from(gen)) {
            return Err("the cross-reference points at another object");
        }
        parser
            .expect_keyword(b"obj")
            .map_err(|_| "the cross-reference points at another object")?;
        parser.object().map_err(|_| "an object that does not parse")
    }
}

/// A cross-reference stream's data, through at most one /FlateDecode with
/// a PNG predictor, as every writer of one uses.
fn decode(dict: &Dict, raw: &[u8]) -> Result<Vec<u8>, &'static str> {
    let single = |key: &str| match dict.get(key) {
        Some(Object::Array(items)) if items.len() == 1 => Some(items[0].clone()),
        Some(Object::Array(items)) if items.is_empty() => None,
        other => other.cloned(),
    };
    let unsupported = "a cross-reference stream filter it cannot read";
    let data = match single("Filter") {
        None => return Ok(raw.to_vec()),
        Some(Object::Name(name)) if decode_name(&name) == b"FlateDecode" => {
            miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(raw, MAX_STREAM)
                .map_err(|_| "a cross-reference stream that does not inflate")?
        }
        _ => return Err(unsupported),
    };
    let params = match single("DecodeParms") {
        None | Some(Object::Null) => Dict::default(),
        Some(Object::Dict(params)) => params,
        _ => return Err(unsupported),
    };
    let predictor = params.int("Predictor").unwrap_or(1);
    if predictor == 1 {
        return Ok(data);
    }
    if !(10..=15).contains(&predictor)
        || params.int("Colors").unwrap_or(1) != 1
        || params.int("BitsPerComponent").unwrap_or(8) != 8
    {
        return Err(unsupported);
    }
    let columns = params
        .int("Columns")
        .unwrap_or(1)
        .try_into()
        .ok()
        .filter(|&c: &usize| c > 0)
        .ok_or(unsupported)?;
    unpredict_png(&data, columns)
}

/// Undoes PNG row filters, one byte per pixel.
fn unpredict_png(data: &[u8], columns: usize) -> Result<Vec<u8>, &'static str> {
    let mut out: Vec<u8> = Vec::with_capacity(data.len());
    let mut previous = vec![0u8; columns];
    for line in data.chunks(columns + 1) {
        if line.len() != columns + 1 {
            return Err("a cross-reference stream with a partial row");
        }
        let mut row = line[1..].to_vec();
        for i in 0..columns {
            let left = if i > 0 { row[i - 1] } else { 0 };
            let up = previous[i];
            let up_left = if i > 0 { previous[i - 1] } else { 0 };
            row[i] = row[i].wrapping_add(match line[0] {
                0 => 0,
                1 => left,
                2 => up,
                3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
                4 => paeth(left, up, up_left),
                _ => return Err("a cross-reference stream with an unknown PNG filter"),
            });
        }
        out.extend_from_slice(&row);
        previous = row;
    }
    Ok(out)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i16::from(a) + i16::from(b) - i16::from(c);
    let (pa, pb, pc) = (
        (p - i16::from(a)).abs(),
        (p - i16::from(b)).abs(),
        (p - i16::from(c)).abs(),
    );
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // What can go wrong between `startxref` and the object it leads to:
    // - an object that appears later in the text than the listed one wins:
    //   a comment after %%EOF, a stale copy an update left unlisted, a whole
    //   PDF inside a stream;
    // - an older section's entry or object beats a newer one's, or a newer
    //   free entry fails to delete the object;
    // - a trailer key an update left out is lost instead of carried over;
    // - a cross-reference stream is misread: Flate, PNG predictors, /Index,
    //   a type field of width 0, /Prev from a stream into a table;
    // - a hybrid file's /XRefStm is ignored, or overrides the table's
    //   in-use entries;
    // - offsets are counted from byte 0 when the header starts later;
    // - something unreadable is guessed at instead of refused: no
    //   startxref, one that points at no section or past the end, an offset
    //   that holds another object or generation, an unlisted, free or
    //   compressed object, a /Prev loop, an unknown filter or predictor.

    /// A file assembled piece by piece, with the offsets its sections give.
    struct File {
        out: Vec<u8>,
        base: usize,
    }

    impl File {
        fn new() -> Self {
            File::with_prefix(b"")
        }

        fn with_prefix(prefix: &[u8]) -> Self {
            let mut out = prefix.to_vec();
            let base = out.len();
            out.extend_from_slice(b"%PDF-1.7\n");
            File { out, base }
        }

        fn at(&self) -> usize {
            self.out.len() - self.base
        }

        fn put(&mut self, text: &str) -> usize {
            let at = self.at();
            self.out.extend_from_slice(text.as_bytes());
            at
        }

        fn object(&mut self, num: u32, body: &str) -> usize {
            self.put(&format!("{num} 0 obj\n{body}\nendobj\n"))
        }

        /// A classic section: (num, offset, gen, in use) one subsection each.
        fn table(&mut self, entries: &[(u32, usize, u16, bool)], trailer: &str) -> usize {
            let at = self.put("xref\n");
            for &(num, offset, gen, used) in entries {
                let kind = if used { 'n' } else { 'f' };
                self.put(&format!("{num} 1\n{offset:010} {gen:05} {kind} \n"));
            }
            self.put(&format!("trailer\n<< {trailer} >>\n"));
            at
        }

        fn stream(&mut self, num: u32, dict: &str, data: &[u8]) -> usize {
            let at = self.put(&format!(
                "{num} 0 obj\n<< {dict} /Length {} >>\nstream\n",
                data.len()
            ));
            self.out.extend_from_slice(data);
            self.put("\nendstream\nendobj\n");
            at
        }

        fn end(mut self, startxref: usize) -> Vec<u8> {
            self.put(&format!("startxref\n{startxref}\n%%EOF\n"));
            self.out
        }
    }

    /// Rows of big-endian fields, Flate-compressed under PNG Up (/Predictor 12).
    fn png_up(rows: &[Vec<u8>]) -> Vec<u8> {
        let mut raw = Vec::new();
        let mut previous = vec![0u8; rows[0].len()];
        for row in rows {
            raw.push(2);
            raw.extend(row.iter().zip(&previous).map(|(b, p)| b.wrapping_sub(*p)));
            previous = row.clone();
        }
        miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6)
    }

    fn row(kind: u8, field: u32, last: u8) -> Vec<u8> {
        let mut row = vec![kind];
        row.extend_from_slice(&field.to_be_bytes());
        row.push(last);
        row
    }

    fn name_of(object: Result<Object, &'static str>) -> Vec<u8> {
        match object {
            Ok(Object::Dict(dict)) => dict.name("N").expect("no /N"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reads_the_object_its_table_lists_not_a_later_one_in_the_text() {
        let mut file = File::new();
        let live = file.object(5, "<< /N /Live >>");
        file.object(5, "<< /N /Stale >>");
        let xref = file.table(&[(5, live, 0, true)], "/Size 6 /Encrypt 5 0 R");
        let mut bytes = file.end(xref);
        bytes.extend_from_slice(b"% 5 0 obj << /N /Comment >> endobj\n");
        bytes.extend_from_slice(b"5 0 obj << /N /Trailing >> endobj\n");
        let xref = CrossReference::read(&bytes).unwrap();
        assert_eq!(name_of(xref.object(5, 0)), b"Live");
        let encrypt = xref.trailer("Encrypt").unwrap();
        assert_eq!(name_of(xref.resolve(encrypt)), b"Live");
    }

    #[test]
    fn a_newer_section_wins_and_trailer_keys_carry_over_from_older_ones() {
        let mut file = File::new();
        let first = file.object(5, "<< /N /First >>");
        let kept = file.object(6, "<< /N /Kept >>");
        let deleted = file.object(7, "<< /N /Deleted >>");
        let old = file.table(
            &[
                (5, first, 0, true),
                (6, kept, 0, true),
                (7, deleted, 0, true),
            ],
            "/Size 8 /Encrypt 5 0 R /ID [<aa> <bb>]",
        );
        let second = file.object(5, "<< /N /Second >>");
        let xref = file.table(
            &[(5, second, 0, true), (7, 0, 1, false)],
            &format!("/Size 8 /Encrypt 5 0 R /Prev {old}"),
        );
        let bytes = file.end(xref);
        let xref = CrossReference::read(&bytes).unwrap();
        assert_eq!(name_of(xref.object(5, 0)), b"Second");
        assert_eq!(name_of(xref.object(6, 0)), b"Kept");
        assert!(xref.object(7, 0).is_err(), "a freed object read");
        assert_eq!(
            xref.trailer("ID"),
            Some(&Object::Array(vec![
                Object::String(vec![0xaa]),
                Object::String(vec![0xbb])
            ]))
        );
    }

    #[test]
    fn reads_cross_reference_streams_with_png_predictors_index_and_prev() {
        let mut file = File::new();
        let first = file.object(3, "<< /N /First >>");
        let table = file.table(&[(3, first, 0, true)], "/Size 4 /ID [<01> <02>]");
        let live = file.object(3, "<< /N /Live >>");
        file.object(3, "<< /N /Stale >>");
        let encrypt = file.object(9, "<< /N /Encrypt >>");
        // Objects 3, 9 in use; 8 compressed; 10 the stream itself.
        let stream_at = file.at();
        let rows = [
            row(1, live as u32, 0),
            row(2, 4, 0),
            row(1, encrypt as u32, 0),
            row(1, stream_at as u32, 0),
        ];
        file.stream(
            10,
            &format!(
                "/Type /XRef /Size 11 /W [1 4 1] /Index [3 1 8 3] /Filter /FlateDecode \
                 /DecodeParms << /Predictor 12 /Columns 6 >> /Encrypt 9 0 R /Prev {table}"
            ),
            &png_up(&rows),
        );
        let bytes = file.end(stream_at);
        let xref = CrossReference::read(&bytes).unwrap();
        assert_eq!(name_of(xref.object(3, 0)), b"Live");
        assert_eq!(
            name_of(xref.resolve(xref.trailer("Encrypt").unwrap())),
            b"Encrypt"
        );
        assert!(
            xref.trailer("ID").is_some(),
            "the table's /ID was not carried over"
        );
        assert!(
            xref.object(8, 0).is_err(),
            "a compressed object read in place"
        );
    }

    #[test]
    fn a_type_field_of_width_zero_means_in_use() {
        let mut file = File::new();
        let live = file.object(1, "<< /N /Live >>");
        let stream_at = file.at();
        let mut data = Vec::new();
        for offset in [live, stream_at] {
            data.extend_from_slice(&(offset as u16).to_be_bytes());
        }
        file.stream(2, "/Type /XRef /Size 3 /W [0 2 0] /Index [1 2]", &data);
        let bytes = file.end(stream_at);
        let xref = CrossReference::read(&bytes).unwrap();
        assert_eq!(name_of(xref.object(1, 0)), b"Live");
    }

    #[test]
    fn a_hybrid_file_fills_its_free_table_entries_from_xrefstm_and_no_others() {
        let mut file = File::new();
        let table_live = file.object(4, "<< /N /Table >>");
        let hidden = file.object(5, "<< /N /Hidden >>");
        let stream_live = file.object(4, "<< /N /StreamCopy >>");
        let stream_at = file.at();
        let mut data = Vec::new();
        for offset in [stream_live, hidden] {
            data.extend_from_slice(&[1]);
            data.extend_from_slice(&(offset as u32).to_be_bytes());
            data.push(0);
        }
        file.stream(9, "/Type /XRef /Size 10 /W [1 4 1] /Index [4 2]", &data);
        let xref = file.table(
            &[(4, table_live, 0, true), (5, 0, 0, false)],
            &format!("/Size 10 /XRefStm {stream_at}"),
        );
        let bytes = file.end(xref);
        let xref = CrossReference::read(&bytes).unwrap();
        assert_eq!(name_of(xref.object(4, 0)), b"Table");
        assert_eq!(name_of(xref.object(5, 0)), b"Hidden");
    }

    #[test]
    fn offsets_count_from_the_header() {
        let mut file = File::with_prefix(b"junk before the header\n");
        let live = file.object(1, "<< /N /Live >>");
        let xref = file.table(&[(1, live, 0, true)], "/Size 2");
        let bytes = file.end(xref);
        let xref = CrossReference::read(&bytes).unwrap();
        assert_eq!(name_of(xref.object(1, 0)), b"Live");
    }

    #[test]
    fn what_it_cannot_follow_is_refused_not_guessed() {
        let simple = |startxref: Option<&str>| {
            let mut file = File::new();
            let live = file.object(5, "<< /N /Live >>");
            let xref = file.table(&[(5, live, 0, true)], "/Size 6");
            let mut bytes = file.out.clone();
            if let Some(text) = startxref {
                bytes.extend_from_slice(text.replace("{xref}", &xref.to_string()).as_bytes());
            }
            bytes
        };
        assert!(CrossReference::read(&simple(Some("startxref\n{xref}\n%%EOF\n"))).is_ok());
        for broken in [
            None,
            Some("startxref\n0\n%%EOF\n"),
            Some("startxref\n999999\n%%EOF\n"),
            Some("startxref\nnone\n%%EOF\n"),
        ] {
            assert!(CrossReference::read(&simple(broken)).is_err(), "{broken:?}");
        }

        // An entry that points at another object, or the right one under
        // another generation, an unlisted object, a /Prev loop.
        let mut file = File::new();
        let five = file.object(5, "<< /N /Five >>");
        let six = file.object(6, "<< /N /Six >>");
        let xref = file.table(&[(5, six, 0, true), (6, six, 3, true)], "/Size 7");
        let bytes = file.end(xref);
        let xref = CrossReference::read(&bytes).unwrap();
        assert!(xref.object(5, 0).is_err(), "read what another offset holds");
        assert!(xref.object(6, 3).is_err(), "read another generation");
        assert!(
            xref.object(6, 0).is_err(),
            "read a generation the table does not give"
        );
        assert!(xref.object(4, 0).is_err(), "read an unlisted object");
        let _ = five;

        let mut file = File::new();
        let at = file.at();
        let looped = file.table(&[], &format!("/Size 1 /Prev {at}"));
        assert_eq!(looped, at);
        assert!(CrossReference::read(&file.end(at)).is_err(), "a /Prev loop");

        for (filter, data) in [
            ("/Filter /LZWDecode", vec![0u8; 6]),
            (
                "/Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 6 >>",
                miniz_oxide::deflate::compress_to_vec_zlib(&[0u8; 6], 6),
            ),
            ("", vec![0u8; 3]),
        ] {
            let mut file = File::new();
            let at = file.at();
            file.stream(
                1,
                &format!("/Type /XRef /Size 2 /W [1 4 1] {filter}"),
                &data,
            );
            assert!(CrossReference::read(&file.end(at)).is_err(), "{filter:?}");
        }
    }

    #[test]
    fn the_header_and_keywords_are_whole_tokens() {
        // `startxref` inside a longer word is not one.
        let mut file = File::new();
        let live = file.object(1, "<< /N /Live >>");
        let xref = file.table(&[(1, live, 0, true)], "/Size 2");
        let mut bytes = file.end(xref);
        bytes.extend_from_slice(b"% notstartxref\n");
        assert!(CrossReference::read(&bytes).is_ok());
    }
}
