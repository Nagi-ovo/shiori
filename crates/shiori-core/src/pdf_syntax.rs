//! Just enough PDF object syntax (ISO 32000-1 §7.2–7.5) to rewrite a file
//! object by object, for re-encrypting an export (src/encryption.rs).
//!
//! Atoms keep the bytes they were written with (numbers, names), strings
//! keep their decoded bytes, and the writer puts a space between every two
//! tokens, so what is written back means exactly what was read. Streams are
//! never decoded here; their data is carried as raw bytes.

use std::fmt;

/// A direct object.
#[derive(Clone, Debug, PartialEq)]
pub enum Object {
    Null,
    Bool(bool),
    /// A number as written.
    Number(Vec<u8>),
    /// A name as written, without its slash; `#xx` escapes are kept.
    Name(Vec<u8>),
    /// A string's bytes, after escapes or hex are decoded.
    String(Vec<u8>),
    Array(Vec<Object>),
    Dict(Dict),
    Ref(u32, u16),
}

/// A dictionary in file order. Keys are names as written, without slash.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Dict(pub Vec<(Vec<u8>, Object)>);

impl Dict {
    pub fn get(&self, key: &str) -> Option<&Object> {
        self.0
            .iter()
            .rev()
            .find(|(name, _)| decode_name(name) == key.as_bytes())
            .map(|(_, value)| value)
    }

    pub fn set(&mut self, key: &str, value: Object) {
        self.remove(key);
        self.0.push((key.as_bytes().to_vec(), value));
    }

    pub fn remove(&mut self, key: &str) {
        self.0
            .retain(|(name, _)| decode_name(name) != key.as_bytes());
    }

    /// The name stored under `key`, decoded.
    pub fn name(&self, key: &str) -> Option<Vec<u8>> {
        match self.get(key) {
            Some(Object::Name(name)) => Some(decode_name(name)),
            _ => None,
        }
    }

    pub fn int(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(Object::as_int)
    }
}

impl Object {
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Object::Number(raw) => std::str::from_utf8(raw).ok()?.parse().ok(),
            _ => None,
        }
    }

    pub fn as_dict(&self) -> Option<&Dict> {
        match self {
            Object::Dict(dict) => Some(dict),
            _ => None,
        }
    }

    pub fn number(value: impl fmt::Display) -> Object {
        Object::Number(value.to_string().into_bytes())
    }

    pub fn name(value: &str) -> Object {
        Object::Name(value.as_bytes().to_vec())
    }
}

/// A name's bytes with its `#xx` escapes resolved.
pub fn decode_name(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'#' && i + 2 < raw.len() {
            if let (Some(hi), Some(lo)) = (hex_value(raw[i + 1]), hex_value(raw[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyntaxError {
    pub offset: usize,
    pub detail: &'static str,
}

impl fmt::Display for SyntaxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.detail, self.offset)
    }
}

/// Deeper nesting than this is refused rather than recursed into.
const MAX_DEPTH: usize = 256;

pub fn is_whitespace(byte: u8) -> bool {
    matches!(byte, 0 | 9 | 10 | 12 | 13 | 32)
}

pub fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn is_regular(byte: u8) -> bool {
    !is_whitespace(byte) && !is_delimiter(byte)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub struct Parser<'a> {
    pub buf: &'a [u8],
    pub pos: usize,
}

impl<'a> Parser<'a> {
    pub fn new(buf: &'a [u8], pos: usize) -> Self {
        Parser { buf, pos }
    }

    fn error(&self, detail: &'static str) -> SyntaxError {
        SyntaxError {
            offset: self.pos,
            detail,
        }
    }

    pub fn at_end(&self) -> bool {
        self.pos >= self.buf.len()
    }

    /// Skips white space and comments.
    pub fn skip_whitespace(&mut self) {
        while let Some(&byte) = self.buf.get(self.pos) {
            if is_whitespace(byte) {
                self.pos += 1;
            } else if byte == b'%' {
                while let Some(&byte) = self.buf.get(self.pos) {
                    if byte == b'\r' || byte == b'\n' {
                        break;
                    }
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    /// Whether `keyword` starts here as a whole token.
    pub fn at_keyword(&self, keyword: &[u8]) -> bool {
        self.buf[self.pos.min(self.buf.len())..].starts_with(keyword)
            && self
                .buf
                .get(self.pos + keyword.len())
                .is_none_or(|&next| !is_regular(next))
    }

    pub fn expect_keyword(&mut self, keyword: &'static [u8]) -> Result<(), SyntaxError> {
        self.skip_whitespace();
        if !self.at_keyword(keyword) {
            return Err(self.error(match keyword {
                b"obj" => "expected obj",
                b"endobj" => "expected endobj",
                b"endstream" => "expected endstream",
                _ => "expected a keyword",
            }));
        }
        self.pos += keyword.len();
        Ok(())
    }

    /// A run of regular characters.
    pub fn token(&mut self) -> &'a [u8] {
        let start = self.pos;
        while self.buf.get(self.pos).is_some_and(|&b| is_regular(b)) {
            self.pos += 1;
        }
        &self.buf[start..self.pos]
    }

    /// An unsigned integer token, or None with the position unchanged.
    pub fn unsigned(&mut self) -> Option<u64> {
        let start = self.pos;
        let token = self.token();
        if !token.is_empty() && token.iter().all(u8::is_ascii_digit) {
            if let Some(value) = std::str::from_utf8(token).ok().and_then(|s| s.parse().ok()) {
                return Some(value);
            }
        }
        self.pos = start;
        None
    }

    pub fn object(&mut self) -> Result<Object, SyntaxError> {
        self.object_at_depth(0)
    }

    fn object_at_depth(&mut self, depth: usize) -> Result<Object, SyntaxError> {
        if depth > MAX_DEPTH {
            return Err(self.error("objects nested too deeply"));
        }
        self.skip_whitespace();
        let Some(&first) = self.buf.get(self.pos) else {
            return Err(self.error("unexpected end of file"));
        };
        match first {
            b'<' if self.buf.get(self.pos + 1) == Some(&b'<') => {
                self.pos += 2;
                let mut dict = Dict::default();
                loop {
                    self.skip_whitespace();
                    match self.buf.get(self.pos) {
                        Some(b'>') if self.buf.get(self.pos + 1) == Some(&b'>') => {
                            self.pos += 2;
                            return Ok(Object::Dict(dict));
                        }
                        Some(b'/') => {
                            self.pos += 1;
                            let key = self.token().to_vec();
                            let value = self.object_at_depth(depth + 1)?;
                            dict.0.push((key, value));
                        }
                        _ => return Err(self.error("expected a name key in a dictionary")),
                    }
                }
            }
            b'<' => {
                self.pos += 1;
                self.hex_string().map(Object::String)
            }
            b'(' => {
                self.pos += 1;
                self.literal_string().map(Object::String)
            }
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_whitespace();
                    if self.buf.get(self.pos) == Some(&b']') {
                        self.pos += 1;
                        return Ok(Object::Array(items));
                    }
                    if self.at_end() {
                        return Err(self.error("unterminated array"));
                    }
                    items.push(self.object_at_depth(depth + 1)?);
                }
            }
            b'/' => {
                self.pos += 1;
                Ok(Object::Name(self.token().to_vec()))
            }
            _ => {
                if let Some(number) = self.unsigned() {
                    // `num gen R` is a reference; otherwise a plain integer.
                    let after_number = self.pos;
                    self.skip_whitespace();
                    if let Some(generation) = self.unsigned() {
                        self.skip_whitespace();
                        if self.at_keyword(b"R") {
                            self.pos += 1;
                            return match (u32::try_from(number), u16::try_from(generation)) {
                                (Ok(num), Ok(gen)) => Ok(Object::Ref(num, gen)),
                                _ => Err(self.error("reference out of range")),
                            };
                        }
                    }
                    self.pos = after_number;
                    return Ok(Object::Number(number.to_string().into_bytes()));
                }
                let token = self.token();
                match token {
                    b"true" => Ok(Object::Bool(true)),
                    b"false" => Ok(Object::Bool(false)),
                    b"null" => Ok(Object::Null),
                    _ if !token.is_empty()
                        && token
                            .iter()
                            .all(|&b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.')) =>
                    {
                        Ok(Object::Number(token.to_vec()))
                    }
                    _ => Err(self.error("unexpected token")),
                }
            }
        }
    }

    /// After `<`: hex digits up to `>`, white space ignored, an odd final
    /// digit padded with 0 (§7.3.4.3).
    fn hex_string(&mut self) -> Result<Vec<u8>, SyntaxError> {
        let mut out = Vec::new();
        let mut high: Option<u8> = None;
        loop {
            let Some(&byte) = self.buf.get(self.pos) else {
                return Err(self.error("unterminated hex string"));
            };
            self.pos += 1;
            if byte == b'>' {
                if let Some(high) = high {
                    out.push(high << 4);
                }
                return Ok(out);
            }
            if is_whitespace(byte) {
                continue;
            }
            let Some(value) = hex_value(byte) else {
                return Err(self.error("bad hex string digit"));
            };
            match high.take() {
                Some(h) => out.push(h << 4 | value),
                None => high = Some(value),
            }
        }
    }

    /// After `(`: balanced parentheses, escapes, and end-of-line markers
    /// read as a single LF (§7.3.4.2).
    fn literal_string(&mut self) -> Result<Vec<u8>, SyntaxError> {
        let mut out = Vec::new();
        let mut depth = 1usize;
        loop {
            let Some(&byte) = self.buf.get(self.pos) else {
                return Err(self.error("unterminated string"));
            };
            self.pos += 1;
            match byte {
                b'\\' => {
                    let Some(&escaped) = self.buf.get(self.pos) else {
                        return Err(self.error("unterminated string"));
                    };
                    self.pos += 1;
                    match escaped {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'0'..=b'7' => {
                            let mut value = u32::from(escaped - b'0');
                            for _ in 0..2 {
                                match self.buf.get(self.pos) {
                                    Some(&digit @ b'0'..=b'7') => {
                                        value = value * 8 + u32::from(digit - b'0');
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push((value & 0xff) as u8);
                        }
                        // A backslash before an end of line continues the line.
                        b'\r' => {
                            if self.buf.get(self.pos) == Some(&b'\n') {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        // `\(`, `\)`, `\\`, and an unknown escape: the character itself.
                        other => out.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    out.push(byte);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(out);
                    }
                    out.push(byte);
                }
                b'\r' => {
                    if self.buf.get(self.pos) == Some(&b'\n') {
                        self.pos += 1;
                    }
                    out.push(b'\n');
                }
                _ => out.push(byte),
            }
        }
    }
}

/// An indirect object: its value and, for a stream, the stream's raw data.
#[derive(Clone, Debug, PartialEq)]
pub struct IndirectObject {
    pub num: u32,
    pub gen: u16,
    pub value: Object,
    pub stream: Option<Vec<u8>>,
}

/// A file read top to bottom: its version, objects, and trailer.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedFile {
    /// The version in the header, e.g. `1.7`.
    pub version: Vec<u8>,
    /// Every object, later definitions of a number replacing earlier ones.
    pub objects: Vec<IndirectObject>,
    /// The last classic trailer, or the last cross-reference stream's dictionary.
    pub trailer: Dict,
}

/// The version after `%PDF-` near the start of `buf`.
pub fn header_version(buf: &[u8]) -> Option<Vec<u8>> {
    let window = &buf[..buf.len().min(1024)];
    let at = window.windows(5).position(|w| w == b"%PDF-")?;
    let mut parser = Parser::new(buf, at + 5);
    let version = parser.token();
    (!version.is_empty()).then(|| version.to_vec())
}

/// Reads a file written front to back, as pdf-lib writes one: objects in
/// sequence, classic cross-reference sections or streams, trailers. A
/// stream's /Length must be a direct integer; this is for files Shiori wrote,
/// not for repairing arbitrary ones.
pub fn parse_file(buf: &[u8]) -> Result<ParsedFile, SyntaxError> {
    let version = header_version(buf).ok_or(SyntaxError {
        offset: 0,
        detail: "no %PDF- header",
    })?;
    let mut parser = Parser::new(buf, 0);
    let mut objects: Vec<IndirectObject> = Vec::new();
    let mut trailer: Option<Dict> = None;
    let mut xref_stream_trailer: Option<Dict> = None;
    loop {
        parser.skip_whitespace();
        if parser.at_end() {
            break;
        }
        if parser.at_keyword(b"xref") {
            parser.pos += 4;
            // Entries: numbers and the f / n markers, up to `trailer`.
            loop {
                parser.skip_whitespace();
                if parser.at_end() || parser.at_keyword(b"trailer") {
                    break;
                }
                if parser.token().is_empty() {
                    return Err(parser.error("bad cross-reference section"));
                }
            }
            continue;
        }
        if parser.at_keyword(b"trailer") {
            parser.pos += 7;
            match parser.object()? {
                Object::Dict(dict) => trailer = Some(dict),
                _ => return Err(parser.error("trailer is not a dictionary")),
            }
            continue;
        }
        if parser.at_keyword(b"startxref") {
            parser.pos += 9;
            parser.skip_whitespace();
            parser.token();
            continue;
        }
        let start = parser.pos;
        let (Some(num), Some(gen)) = (parser.unsigned(), {
            parser.skip_whitespace();
            parser.unsigned()
        }) else {
            parser.pos = start;
            return Err(parser.error("expected an object"));
        };
        let num = u32::try_from(num).map_err(|_| parser.error("object number out of range"))?;
        let gen = u16::try_from(gen).map_err(|_| parser.error("generation out of range"))?;
        parser.expect_keyword(b"obj")?;
        let value = parser.object()?;
        parser.skip_whitespace();
        let mut stream = None;
        if parser.at_keyword(b"stream") {
            parser.pos += 6;
            // The keyword ends with CRLF or LF (§7.3.8.1); tolerate a bare CR.
            if parser.buf.get(parser.pos) == Some(&b'\r') {
                parser.pos += 1;
            }
            if parser.buf.get(parser.pos) == Some(&b'\n') {
                parser.pos += 1;
            }
            let length = value
                .as_dict()
                .and_then(|dict| dict.int("Length"))
                .and_then(|length| usize::try_from(length).ok())
                .ok_or_else(|| parser.error("stream /Length is not a direct integer"))?;
            let end = parser
                .pos
                .checked_add(length)
                .filter(|&end| end <= buf.len())
                .ok_or_else(|| parser.error("stream runs past the end of the file"))?;
            stream = Some(buf[parser.pos..end].to_vec());
            parser.pos = end;
            parser.expect_keyword(b"endstream")?;
            if value
                .as_dict()
                .and_then(|dict| dict.name("Type"))
                .is_some_and(|kind| kind == b"XRef")
            {
                xref_stream_trailer = value.as_dict().cloned();
            }
        }
        parser.expect_keyword(b"endobj")?;
        objects.retain(|object| object.num != num);
        objects.push(IndirectObject {
            num,
            gen,
            value,
            stream,
        });
    }
    let trailer = trailer.or(xref_stream_trailer).ok_or(SyntaxError {
        offset: buf.len(),
        detail: "no trailer",
    })?;
    Ok(ParsedFile {
        version,
        objects,
        trailer,
    })
}

/// Writes `object` in PDF syntax. Strings are written in hex.
pub fn write_object(out: &mut Vec<u8>, object: &Object) {
    match object {
        Object::Null => out.extend_from_slice(b"null"),
        Object::Bool(true) => out.extend_from_slice(b"true"),
        Object::Bool(false) => out.extend_from_slice(b"false"),
        Object::Number(raw) => out.extend_from_slice(raw),
        Object::Name(raw) => {
            out.push(b'/');
            out.extend_from_slice(raw);
        }
        Object::String(bytes) => write_hex_string(out, bytes),
        Object::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b' ');
                }
                write_object(out, item);
            }
            out.push(b']');
        }
        Object::Dict(dict) => {
            out.extend_from_slice(b"<<");
            for (key, value) in &dict.0 {
                out.push(b'/');
                out.extend_from_slice(key);
                out.push(b' ');
                write_object(out, value);
                out.push(b'\n');
            }
            out.extend_from_slice(b">>");
        }
        Object::Ref(num, gen) => out.extend_from_slice(format!("{num} {gen} R").as_bytes()),
    }
}

pub fn write_hex_string(out: &mut Vec<u8>, bytes: &[u8]) {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    out.reserve(bytes.len() * 2 + 2);
    out.push(b'<');
    for &byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)]);
        out.push(DIGITS[usize::from(byte & 15)]);
    }
    out.push(b'>');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &[u8]) -> Object {
        Parser::new(text, 0).object().unwrap()
    }

    #[test]
    fn literal_strings_decode_escapes_nesting_and_line_ends() {
        assert_eq!(
            parse(br"(a\(b\)c (nested) \\ \n\101\0532 end)"),
            Object::String(b"a(b)c (nested) \\ \nA+2 end".to_vec())
        );
        // A backslash before an end of line continues the line; a bare CRLF
        // inside a string reads as one LF.
        assert_eq!(
            parse(b"(one\\\r\ntwo\r\nthree)"),
            Object::String(b"onetwo\nthree".to_vec())
        );
        // An octal escape of more than three digits takes three.
        assert_eq!(parse(br"(\0612)"), Object::String(b"12".to_vec()));
    }

    #[test]
    fn hex_strings_ignore_white_space_and_pad_an_odd_digit() {
        assert_eq!(
            parse(b"<FE FF 00 4\n1 7>"),
            Object::String(vec![0xfe, 0xff, 0x00, 0x41, 0x70])
        );
    }

    #[test]
    fn references_numbers_and_names_read_back_as_written() {
        let object = parse(b"<< /A 12 0 R /B [1 -2.5 +3 .5] /C#20D /x /E [7 8 /R] >>");
        let dict = object.as_dict().unwrap();
        assert_eq!(dict.get("A"), Some(&Object::Ref(12, 0)));
        assert_eq!(
            dict.get("B"),
            Some(&Object::Array(vec![
                Object::number(1),
                Object::Number(b"-2.5".to_vec()),
                Object::Number(b"+3".to_vec()),
                Object::Number(b".5".to_vec()),
            ]))
        );
        // The key is found by its decoded name, and kept as written.
        assert_eq!(dict.get("C D"), Some(&Object::Name(b"x".to_vec())));
        assert_eq!(dict.0[2].0, b"C#20D".to_vec());
        // `7 8` without R is two numbers, not a reference.
        assert_eq!(
            dict.get("E"),
            Some(&Object::Array(vec![
                Object::number(7),
                Object::number(8),
                Object::name("R")
            ]))
        );
    }

    #[test]
    fn written_objects_parse_back_to_the_same_value() {
        let object = parse(b"<< /K [(a\\)b) <00ff> true null /N#2F 3 0 R] /L << /M -1 >> >>");
        let mut out = Vec::new();
        write_object(&mut out, &object);
        assert_eq!(parse(&out), object);
    }

    #[test]
    fn a_stream_is_read_by_its_length_even_when_it_contains_endstream() {
        let mut file = b"%PDF-1.7\n1 0 obj\n<< /Length 13 >>\nstream\nendstream obj\nendstream\nendobj\n2 0 obj\n(x)\nendobj\ntrailer\n<< /Root 1 0 R /Size 3 >>\nstartxref\n0\n%%EOF\n".to_vec();
        let parsed = parse_file(&file).unwrap();
        assert_eq!(parsed.version, b"1.7".to_vec());
        assert_eq!(parsed.objects.len(), 2);
        assert_eq!(
            parsed.objects[0].stream.as_deref(),
            Some(&b"endstream obj"[..])
        );
        assert_eq!(parsed.trailer.get("Root"), Some(&Object::Ref(1, 0)));
        // A /Length that overruns the file is an error, not a panic.
        let at = file.windows(2).position(|w| w == b"13").unwrap();
        file[at..at + 2].copy_from_slice(b"99");
        assert!(parse_file(&file).is_err());
    }

    #[test]
    fn deep_nesting_is_refused_without_overflowing_the_stack() {
        let text = vec![b'['; 100_000];
        assert!(Parser::new(&text, 0).object().is_err());
    }
}
