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
