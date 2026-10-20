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
    let partial = "a cross-reference stream with a partial row";
    if data.is_empty() {
        return Ok(Vec::new());
    }
    // A row is a filter byte and `columns` bytes. One the data cannot hold
    // is refused before a buffer is sized for it: /Columns comes from the file.
    let width = columns
        .checked_add(1)
        .filter(|&width| width <= data.len())
        .ok_or(partial)?;
    let mut out: Vec<u8> = Vec::with_capacity(data.len());
    let mut previous = vec![0u8; columns];
    for line in data.chunks(width) {
        if line.len() != width {
            return Err(partial);
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
mod tests;
