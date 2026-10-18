//! Re-encrypts an export with its source file's own Standard security
//! handler (ISO 32000-2 §7.6.4), so a password-protected PDF stays protected
//! by the same passwords after Shiori edits it.
//!
//! The pipeline (src/pdf/export/encryptedSource.ts): PDFium opens the source
//! with the reader's password and writes a plaintext copy; pdf-lib exports
//! from that copy; [`SourceEncryption::encrypt_file`] encrypts pdf-lib's
//! output under the source's original file key and writes the source's
//! /Encrypt dictionary and /ID[0] back unchanged, so both the user and the
//! owner password still open it. Nothing here makes a new key or password.
//!
//! The key comes from the source file and the password the reader typed,
//! never stored: [`SourceEncryption`] holds the derived key alone.
//!
//! Failure list this module answers to (tests below and in tests/core.rs):
//! - revisions: R2 (RC4-40), R3 (RC4 up to 128), R4 with /V2 (RC4),
//!   /AESV2 or Identity crypt filters, R5 (AES-256, deprecated) and R6
//!   (AES-256, Algorithm 2.B); V3, R7+, /CFM /None, other handlers and
//!   StmF/StrF/EFF that disagree are refused, not guessed at;
//! - password: the user one, the owner one, the empty user password of a
//!   permission-only file, a wrong one (refused), non-ASCII ones (UTF-8 for
//!   R5/R6; Latin-1 or the raw bytes for R2–R4, as PDFium tries them);
//! - /EncryptMetadata false: the key derivation's 0xFFFFFFFF tail, and the
//!   XMP stream left in the clear;
//! - what stays in the clear: the /Encrypt dictionary's strings, the
//!   trailer's /ID, cross-reference streams, a signature's /Contents;
//! - object streams, encrypted as streams, listed in a new cross-reference
//!   stream; classic cross-reference tables otherwise;
//! - where the source keeps /Encrypt and /ID: a classic trailer, a
//!   cross-reference stream, an earlier section reached through /Prev, an
//!   indirect /Encrypt; refs inside /Encrypt are refused;
//! - an input that is already encrypted is refused rather than encrypted twice.

use std::collections::BTreeMap;
use std::fmt;

use aes::cipher::{
    block_padding::NoPadding, block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit,
};
use md5::{Digest, Md5};
use sha2::{Sha256, Sha384, Sha512};

use crate::pdf_syntax::{
    decode_name, header_version, parse_file, write_object, Dict, Object, Parser,
};
use crate::xref::CrossReference;

/// Why a file cannot be re-encrypted. The wording never includes a password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncryptionError {
    /// A handler, revision or layout this module does not reproduce.
    Unsupported(&'static str),
    /// The source's encryption entries or the export could not be read.
    Unreadable(&'static str),
    /// The credentials given do not unlock the source's handler.
    NotUnlocked,
}

impl fmt::Display for EncryptionError {
    // Matched by src/pdf/export/encryptedSource.ts: every variant starts
    // with "re-encryption unsupported", and none says "password" or
    // "damaged", the words classifyPdfOpenError reads as open failures.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EncryptionError::Unsupported(detail) | EncryptionError::Unreadable(detail) => {
                write!(f, "re-encryption unsupported: {detail}")
            }
            EncryptionError::NotUnlocked => write!(
                f,
                "re-encryption unsupported: the credentials do not unlock the security handler"
            ),
        }
    }
}

impl std::error::Error for EncryptionError {}

/// How one class of data (strings, streams, embedded files) is encrypted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Identity,
    Rc4,
    Aes128,
    Aes256,
}

/// A source file's Standard security handler, unlocked.
#[derive(Clone)]
pub struct SourceEncryption {
    encrypt: Dict,
    id0: Vec<u8>,
    source_version: Vec<u8>,
    revision: i64,
    key: Vec<u8>,
    strings: Method,
    streams: Method,
    embedded_files: Method,
    encrypt_metadata: bool,
}

impl fmt::Debug for SourceEncryption {
    // Leaves the key out.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SourceEncryption")
            .field("revision", &self.revision)
            .field("strings", &self.strings)
            .field("streams", &self.streams)
            .finish_non_exhaustive()
    }
}

/// The highest object number a PDF may use (ISO 32000-2 Annex C).
const MAX_OBJECT_NUMBER: u32 = 8_388_607;

/// Algorithm 2's padding string.
const PAD: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

impl SourceEncryption {
    /// Reads `source`'s /Encrypt and /ID and unlocks them with `password`
    /// (empty for no password): the owner password first, then the user one.
    pub fn from_source(source: &[u8], password: &str) -> Result<Self, EncryptionError> {
        let (encrypt, id0) = source_encryption_entries(source)?;
        let version = header_version(source).unwrap_or_else(|| b"1.4".to_vec());
        Self::from_parts(encrypt, id0, version, password)
    }

    pub fn from_parts(
        encrypt: Dict,
        id0: Vec<u8>,
        source_version: Vec<u8>,
        password: &str,
    ) -> Result<Self, EncryptionError> {
        if contains_ref(&Object::Dict(encrypt.clone())) {
            return Err(EncryptionError::Unsupported(
                "indirect values inside /Encrypt",
            ));
        }
        if encrypt.name("Filter").as_deref() != Some(b"Standard") {
            return Err(EncryptionError::Unsupported(
                "a security handler other than Standard",
            ));
        }
        let v = encrypt.int("V").unwrap_or(0);
        let revision = encrypt
            .int("R")
            .ok_or(EncryptionError::Unreadable("/Encrypt has no /R"))?;
        let (strings, streams, embedded_files, key_len) = match v {
            1 => (Method::Rc4, Method::Rc4, Method::Rc4, 5),
            2 => {
                let bits = encrypt.int("Length").unwrap_or(40);
                if !(40..=128).contains(&bits) || bits % 8 != 0 {
                    return Err(EncryptionError::Unsupported(
                        "an RC4 key length outside 40-128 bits",
                    ));
                }
                (Method::Rc4, Method::Rc4, Method::Rc4, (bits / 8) as usize)
            }
            4 | 5 => crypt_filters(&encrypt, v)?,
            _ => {
                return Err(EncryptionError::Unsupported(
                    "this /V of the Standard handler",
                ))
            }
        };
        match (v, revision) {
            (1 | 2, 2 | 3) | (4, 4) | (5, 5 | 6) => {}
            _ => {
                return Err(EncryptionError::Unsupported(
                    "this /R of the Standard handler",
                ))
            }
        }
        if revision == 2 && key_len != 5 {
            return Err(EncryptionError::Unsupported(
                "revision 2 with a key longer than 40 bits",
            ));
        }
        let encrypt_metadata =
            v < 4 || !matches!(encrypt.get("EncryptMetadata"), Some(Object::Bool(false)));
        let string = |key: &str| match encrypt.get(key) {
            Some(Object::String(bytes)) => Ok(bytes.clone()),
            _ => Err(EncryptionError::Unreadable("/Encrypt is missing /O or /U")),
        };
        let (o, u) = (string("O")?, string("U")?);
        let key = if revision <= 4 {
            if o.len() < 32 || u.len() < 32 {
                return Err(EncryptionError::Unreadable("/O or /U is too short"));
            }
            let p = encrypt
                .int("P")
                .ok_or(EncryptionError::Unreadable("/Encrypt has no /P"))?
                as u32;
            let params = R4Params {
                o: &o[..32],
                u: &u[..32],
                p,
                id0: &id0,
                revision,
                key_len,
                encrypt_metadata,
            };
            password_candidates(password)
                .iter()
                .find_map(|candidate| {
                    params
                        .authenticate_owner(candidate)
                        .or_else(|| params.authenticate_user(candidate))
                })
                .ok_or(EncryptionError::NotUnlocked)?
        } else {
            if o.len() < 48 || u.len() < 48 {
                return Err(EncryptionError::Unreadable("/O or /U is too short"));
            }
            let (oe, ue) = (string("OE")?, string("UE")?);
            if oe.len() < 32 || ue.len() < 32 {
                return Err(EncryptionError::Unreadable("/OE or /UE is too short"));
            }
            let password = &password.as_bytes()[..password.len().min(127)];
            authenticate_v5(revision, password, &o[..48], &u[..48], &oe[..32], &ue[..32])
                .ok_or(EncryptionError::NotUnlocked)?
        };
        Ok(SourceEncryption {
            encrypt,
            id0,
            source_version,
            revision,
            key,
            strings,
            streams,
            embedded_files,
            encrypt_metadata,
        })
    }

    pub fn revision(&self) -> i64 {
        self.revision
    }

    /// Encrypts `plain`, a complete unencrypted file written front to back
    /// (pdf-lib's output), under the source's key, and writes the source's
    /// /Encrypt dictionary and /ID[0] into its trailer.
    pub fn encrypt_file(&self, plain: &[u8]) -> Result<Vec<u8>, EncryptionError> {
        let file = parse_file(plain)
            .map_err(|_| EncryptionError::Unreadable("the export could not be read back"))?;
        if file.trailer.get("Encrypt").is_some() {
            return Err(EncryptionError::Unreadable(
                "the export is already encrypted",
            ));
        }
        let root = file
            .trailer
            .get("Root")
            .cloned()
            .ok_or(EncryptionError::Unreadable("the export has no /Root"))?;
        let version = if file.version >= self.source_version {
            file.version.clone()
        } else {
            self.source_version.clone()
        };

        let mut out = Vec::with_capacity(plain.len() + plain.len() / 8 + 1024);
        out.extend_from_slice(b"%PDF-");
        out.extend_from_slice(&version);
        out.extend_from_slice(b"\n%\xE2\xE3\xCF\xD3\n");

        enum Location {
            Offset(usize, u16),
            InStream(u32, u32),
        }
        let mut locations: BTreeMap<u32, Location> = BTreeMap::new();
        // The new table is as long as the highest object number, never the
        // plaintext's /Size: numbers past the spec's limit (ISO 32000-2
        // Annex C), or past one per byte of input, would fill it with
        // gigabytes of free entries, and 0 heads the free list.
        let limit = MAX_OBJECT_NUMBER.min(u32::try_from(plain.len()).unwrap_or(u32::MAX));
        let numbered = |num: u32| {
            if (1..=limit).contains(&num) {
                Ok(num)
            } else {
                Err(EncryptionError::Unsupported("object numbers out of range"))
            }
        };
        let mut max_num = 0;
        let mut in_streams: Vec<(u32, u32, u32)> = Vec::new();

        for object in &file.objects {
            let mut value = object.value.clone();
            let stream = match &object.stream {
                None => None,
                Some(data) => {
                    let Object::Dict(dict) = &mut value else {
                        return Err(EncryptionError::Unreadable("a stream without a dictionary"));
                    };
                    let kind = dict.name("Type");
                    match kind.as_deref() {
                        // Cross-reference streams are never encrypted; a new one is written.
                        Some(b"XRef") => continue,
                        Some(b"ObjStm") => {
                            for (index, member) in
                                object_stream_members(dict, data)?.into_iter().enumerate()
                            {
                                // The index takes two bytes in the new table.
                                let index = u16::try_from(index).map_err(|_| {
                                    EncryptionError::Unsupported("an object stream this long")
                                })?;
                                in_streams.push((numbered(member)?, object.num, index.into()));
                            }
                        }
                        _ => {}
                    }
                    if has_crypt_filter(dict) {
                        return Err(EncryptionError::Unsupported(
                            "streams with their own /Crypt filter",
                        ));
                    }
                    let method = match kind.as_deref() {
                        Some(b"Metadata") if !self.encrypt_metadata => Method::Identity,
                        Some(b"EmbeddedFile") => self.embedded_files,
                        _ => self.streams,
                    };
                    let encrypted = self.encrypt_bytes(method, object.num, object.gen, data)?;
                    dict.set("Length", Object::number(encrypted.len()));
                    Some(encrypted)
                }
            };
            self.encrypt_strings(&mut value, object.num, object.gen)?;
            max_num = max_num.max(numbered(object.num)?);
            locations.insert(object.num, Location::Offset(out.len(), object.gen));
            out.extend_from_slice(format!("{} {} obj\n", object.num, object.gen).as_bytes());
            write_object(&mut out, &value);
            if let Some(data) = stream {
                out.extend_from_slice(b"\nstream\n");
                out.extend_from_slice(&data);
                out.extend_from_slice(b"\nendstream");
            }
            out.extend_from_slice(b"\nendobj\n");
        }
        for (member, stream, index) in in_streams {
            max_num = max_num.max(member);
            locations
                .entry(member)
                .or_insert(Location::InStream(stream, index));
        }

        let too_large = EncryptionError::Unsupported("object numbers out of range");
        let encrypt_num = max_num.checked_add(1).ok_or(too_large.clone())?;
        locations.insert(encrypt_num, Location::Offset(out.len(), 0));
        out.extend_from_slice(format!("{encrypt_num} 0 obj\n").as_bytes());
        write_object(&mut out, &Object::Dict(self.encrypt.clone()));
        out.extend_from_slice(b"\nendobj\n");

        let mut second_id = [0u8; 16];
        getrandom::getrandom(&mut second_id)
            .map_err(|_| EncryptionError::Unsupported("a platform without a random source"))?;
        let mut trailer = Dict::default();
        trailer.set("Root", root);
        if let Some(info) = file.trailer.get("Info") {
            trailer.set("Info", info.clone());
        }
        trailer.set("Encrypt", Object::Ref(encrypt_num, 0));
        trailer.set(
            "ID",
            Object::Array(vec![
                Object::String(self.id0.clone()),
                Object::String(second_id.to_vec()),
            ]),
        );

        let uses_object_streams = locations
            .values()
            .any(|l| matches!(l, Location::InStream(..)));
        if uses_object_streams {
            // A cross-reference stream, the only kind that can point into object streams.
            let xref_num = encrypt_num.checked_add(1).ok_or(too_large.clone())?;
            let xref_offset = out.len();
            locations.insert(xref_num, Location::Offset(xref_offset, 0));
            let size = xref_num.checked_add(1).ok_or(too_large)?;
            let widest = locations
                .values()
                .map(|location| match location {
                    Location::Offset(offset, _) => *offset as u64,
                    Location::InStream(stream, _) => u64::from(*stream),
                })
                .max()
                .unwrap_or(0);
            let width = ((64 - widest.leading_zeros() as usize).div_ceil(8)).max(1);
            let mut rows = Vec::with_capacity(size as usize * (width + 3));
            let mut push = |kind: u8, field: u64, last: u32| {
                rows.push(kind);
                rows.extend_from_slice(&field.to_be_bytes()[8 - width..]);
                rows.extend_from_slice(&(last as u16).to_be_bytes());
            };
            for num in 0..size {
                match locations.get(&num) {
                    Some(Location::Offset(offset, gen)) => push(1, *offset as u64, u32::from(*gen)),
                    Some(Location::InStream(stream, index)) => push(2, u64::from(*stream), *index),
                    None => push(0, 0, if num == 0 { 65535 } else { 0 }),
                }
            }
            let data = miniz_oxide::deflate::compress_to_vec_zlib(&rows, 6);
            trailer.set("Type", Object::name("XRef"));
            trailer.set("Size", Object::number(size));
            trailer.set(
                "W",
                Object::Array(vec![
                    Object::number(1),
                    Object::number(width),
                    Object::number(2),
                ]),
            );
            trailer.set("Filter", Object::name("FlateDecode"));
            trailer.set("Length", Object::number(data.len()));
            out.extend_from_slice(format!("{xref_num} 0 obj\n").as_bytes());
            write_object(&mut out, &Object::Dict(trailer));
            out.extend_from_slice(b"\nstream\n");
            out.extend_from_slice(&data);
            out.extend_from_slice(b"\nendstream\nendobj\n");
            out.extend_from_slice(format!("startxref\n{xref_offset}\n%%EOF\n").as_bytes());
        } else {
            let size = encrypt_num.checked_add(1).ok_or(too_large)?;
            let xref_offset = out.len();
            out.extend_from_slice(format!("xref\n0 {size}\n").as_bytes());
            for num in 0..size {
                let entry = match locations.get(&num) {
                    Some(Location::Offset(offset, gen)) => format!("{offset:010} {gen:05} n\r\n"),
                    _ if num == 0 => "0000000000 65535 f\r\n".to_owned(),
                    _ => "0000000000 00000 f\r\n".to_owned(),
                };
                out.extend_from_slice(entry.as_bytes());
            }
            trailer.set("Size", Object::number(size));
            out.extend_from_slice(b"trailer\n");
            write_object(&mut out, &Object::Dict(trailer));
            out.extend_from_slice(format!("\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes());
        }
        Ok(out)
    }

    /// Every string in `value`, but a signature's /Contents, encrypted.
    fn encrypt_strings(
        &self,
        value: &mut Object,
        num: u32,
        gen: u16,
    ) -> Result<(), EncryptionError> {
        match value {
            Object::String(bytes) => *bytes = self.encrypt_bytes(self.strings, num, gen, bytes)?,
            Object::Array(items) => {
                for item in items {
                    self.encrypt_strings(item, num, gen)?;
                }
            }
            Object::Dict(dict) => {
                // A signature dictionary (/Type /Sig or /DocTimeStamp, both
                // optional, so known by its /ByteRange) keeps /Contents in the clear.
                let signature = dict.get("ByteRange").is_some();
                for (key, item) in &mut dict.0 {
                    if signature && decode_name(key) == b"Contents" {
                        continue;
                    }
                    self.encrypt_strings(item, num, gen)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn object_key(&self, method: Method, num: u32, gen: u16) -> Vec<u8> {
        if method == Method::Aes256 {
            return self.key.clone();
        }
        let mut hash = Md5::new();
        hash.update(&self.key);
        hash.update(&num.to_le_bytes()[..3]);
        hash.update(gen.to_le_bytes());
        if method == Method::Aes128 {
            hash.update(b"sAlT");
        }
        hash.finalize()[..(self.key.len() + 5).min(16)].to_vec()
    }

    fn encrypt_bytes(
        &self,
        method: Method,
        num: u32,
        gen: u16,
        data: &[u8],
    ) -> Result<Vec<u8>, EncryptionError> {
        let key = self.object_key(method, num, gen);
        match method {
            Method::Identity => Ok(data.to_vec()),
            Method::Rc4 => {
                let mut out = data.to_vec();
                rc4(&key, &mut out);
                Ok(out)
            }
            Method::Aes128 | Method::Aes256 => {
                let mut iv = [0u8; 16];
                getrandom::getrandom(&mut iv).map_err(|_| {
                    EncryptionError::Unsupported("a platform without a random source")
                })?;
                let body = if method == Method::Aes128 {
                    cbc::Encryptor::<aes::Aes128>::new_from_slices(&key, &iv)
                        .map_err(|_| EncryptionError::Unreadable("an AES key of the wrong length"))?
                        .encrypt_padded_vec_mut::<Pkcs7>(data)
                } else {
                    cbc::Encryptor::<aes::Aes256>::new_from_slices(&key, &iv)
                        .map_err(|_| EncryptionError::Unreadable("an AES key of the wrong length"))?
                        .encrypt_padded_vec_mut::<Pkcs7>(data)
                };
                let mut out = iv.to_vec();
                out.extend_from_slice(&body);
                Ok(out)
            }
        }
    }

    /// The inverse of `encrypt_bytes`, for the round-trip tests.
    #[cfg(test)]
    fn decrypt_bytes(&self, method: Method, num: u32, gen: u16, data: &[u8]) -> Vec<u8> {
        let key = self.object_key(method, num, gen);
        match method {
            Method::Identity => data.to_vec(),
            Method::Rc4 => {
                let mut out = data.to_vec();
                rc4(&key, &mut out);
                out
            }
            Method::Aes128 => cbc::Decryptor::<aes::Aes128>::new_from_slices(&key, &data[..16])
                .unwrap()
                .decrypt_padded_vec_mut::<Pkcs7>(&data[16..])
                .unwrap(),
            Method::Aes256 => cbc::Decryptor::<aes::Aes256>::new_from_slices(&key, &data[..16])
                .unwrap()
                .decrypt_padded_vec_mut::<Pkcs7>(&data[16..])
                .unwrap(),
        }
    }
}

/// The string, stream and embedded-file methods and the key length of a
/// V4 or V5 handler, as PDFium reads them: one filter for strings and
/// streams, its /Length in bits (or bytes, below 40), AES at 128 or 256.
fn crypt_filters(
    encrypt: &Dict,
    v: i64,
) -> Result<(Method, Method, Method, usize), EncryptionError> {
    let filter_name = |key: &str| encrypt.name(key).unwrap_or_else(|| b"Identity".to_vec());
    let (strf, stmf) = (filter_name("StrF"), filter_name("StmF"));
    let eff = encrypt.name("EFF").unwrap_or_else(|| stmf.clone());
    if strf != stmf || eff != stmf {
        // PDFium decrypts every string and stream with one filter.
        return Err(EncryptionError::Unsupported(
            "different crypt filters for strings, streams or attachments",
        ));
    }
    if stmf == b"Identity" {
        let len = if v == 5 { 32 } else { 16 };
        return Ok((Method::Identity, Method::Identity, Method::Identity, len));
    }
    let filter = encrypt
        .get("CF")
        .and_then(Object::as_dict)
        .and_then(|filters| filters.get(std::str::from_utf8(&stmf).unwrap_or("")))
        .and_then(Object::as_dict)
        .ok_or(EncryptionError::Unreadable(
            "the crypt filter /StmF names is not in /CF",
        ))?;
    let method = match filter.name("CFM").as_deref() {
        Some(b"V2") => Method::Rc4,
        Some(b"AESV2") => Method::Aes128,
        Some(b"AESV3") => Method::Aes256,
        _ => return Err(EncryptionError::Unsupported("this crypt filter method")),
    };
    let mut bits = if v == 4 {
        filter
            .int("Length")
            .filter(|&bits| bits != 0)
            .or_else(|| encrypt.int("Length"))
            .unwrap_or(128)
    } else {
        encrypt.int("Length").unwrap_or(256)
    };
    if bits < 40 {
        bits *= 8;
    }
    let len = usize::try_from(bits / 8).unwrap_or(0);
    let fits = match (v, method) {
        (4, Method::Rc4) => (5..=16).contains(&len) && bits % 8 == 0,
        (4, Method::Aes128) => len == 16,
        (5, Method::Aes256) => len == 32,
        _ => false,
    };
    if !fits {
        return Err(EncryptionError::Unsupported(
            "this crypt filter's key length",
        ));
    }
    Ok((method, method, method, len))
}

struct R4Params<'a> {
    o: &'a [u8],
    u: &'a [u8],
    p: u32,
    id0: &'a [u8],
    revision: i64,
    key_len: usize,
    encrypt_metadata: bool,
}

impl R4Params<'_> {
    /// Algorithm 2: the file key a user password gives.
    fn file_key(&self, password: &[u8]) -> Vec<u8> {
        let mut hash = Md5::new();
        hash.update(pad_password(password));
        hash.update(self.o);
        hash.update(self.p.to_le_bytes());
        hash.update(self.id0);
        if self.revision >= 4 && !self.encrypt_metadata {
            hash.update([0xFF; 4]);
        }
        let mut digest = hash.finalize().to_vec();
        if self.revision >= 3 {
            for _ in 0..50 {
                digest = Md5::digest(&digest[..self.key_len]).to_vec();
            }
        }
        digest.truncate(self.key_len);
        digest
    }

    /// Algorithms 4, 5 and 6: the key, when `password` is the user password.
    fn authenticate_user(&self, password: &[u8]) -> Option<Vec<u8>> {
        let key = self.file_key(password);
        let matches = if self.revision == 2 {
            let mut check = PAD;
            rc4(&key, &mut check);
            check[..] == self.u[..32]
        } else {
            let mut hash = Md5::new();
            hash.update(PAD);
            hash.update(self.id0);
            let mut check = hash.finalize().to_vec();
            for round in 0..20u8 {
                let round_key: Vec<u8> = key.iter().map(|byte| byte ^ round).collect();
                rc4(&round_key, &mut check);
            }
            check[..] == self.u[..16]
        };
        matches.then_some(key)
    }

    /// Algorithm 7: the key, when `password` is the owner password.
    fn authenticate_owner(&self, password: &[u8]) -> Option<Vec<u8>> {
        let mut digest = Md5::digest(pad_password(password)).to_vec();
        if self.revision >= 3 {
            for _ in 0..50 {
                digest = Md5::digest(&digest).to_vec();
            }
        }
        let key = &digest[..self.key_len];
        let mut user = self.o.to_vec();
        if self.revision == 2 {
            rc4(key, &mut user);
        } else {
            for round in (0..20u8).rev() {
                let round_key: Vec<u8> = key.iter().map(|byte| byte ^ round).collect();
                rc4(&round_key, &mut user);
            }
        }
        self.authenticate_user(&user)
    }
}

fn pad_password(password: &[u8]) -> [u8; 32] {
    let mut padded = PAD;
    let len = password.len().min(32);
    padded[..len].copy_from_slice(&password[..len]);
    padded[len..].copy_from_slice(&PAD[..32 - len]);
    padded
}

/// The bytes a R2–R4 password may have been encrypted under: Latin-1 (the
/// PDFDocEncoding of most characters) when every character fits, and the
/// UTF-8 bytes as typed.
fn password_candidates(password: &str) -> Vec<Vec<u8>> {
    let mut candidates = Vec::with_capacity(2);
    if password.chars().all(|c| u32::from(c) <= 0xFF) {
        candidates.push(password.chars().map(|c| u32::from(c) as u8).collect());
    }
    if candidates
        .first()
        .is_none_or(|latin1: &Vec<u8>| latin1.as_slice() != password.as_bytes())
    {
        candidates.push(password.as_bytes().to_vec());
    }
    candidates
}

/// Algorithms 2.A/11/12: the key, unlocked by the owner password first.
fn authenticate_v5(
    revision: i64,
    password: &[u8],
    o: &[u8],
    u: &[u8],
    oe: &[u8],
    ue: &[u8],
) -> Option<Vec<u8>> {
    let decrypt = |key: [u8; 32], wrapped: &[u8]| {
        cbc::Decryptor::<aes::Aes256>::new_from_slices(&key, &[0u8; 16])
            .ok()?
            .decrypt_padded_vec_mut::<NoPadding>(wrapped)
            .ok()
    };
    if v5_hash(revision, password, &o[32..40], u) == o[..32] {
        return decrypt(v5_hash(revision, password, &o[40..48], u), oe);
    }
    if v5_hash(revision, password, &u[32..40], &[]) == u[..32] {
        return decrypt(v5_hash(revision, password, &u[40..48], &[]), ue);
    }
    None
}

/// SHA-256 for revision 5; Algorithm 2.B for revision 6.
fn v5_hash(revision: i64, password: &[u8], salt: &[u8], udata: &[u8]) -> [u8; 32] {
    let mut k: Vec<u8> = Sha256::new()
        .chain_update(password)
        .chain_update(salt)
        .chain_update(udata)
        .finalize()
        .to_vec();
    if revision == 6 {
        let mut round = 0u32;
        loop {
            round += 1;
            let mut k1 = Vec::with_capacity(64 * (password.len() + k.len() + udata.len()));
            for _ in 0..64 {
                k1.extend_from_slice(password);
                k1.extend_from_slice(&k);
                k1.extend_from_slice(udata);
            }
            let Ok(cipher) = cbc::Encryptor::<aes::Aes128>::new_from_slices(&k[..16], &k[16..32])
            else {
                break;
            };
            let e = cipher.encrypt_padded_vec_mut::<NoPadding>(&k1);
            let selector: u32 = e[..16].iter().map(|&byte| u32::from(byte)).sum::<u32>() % 3;
            k = match selector {
                0 => Sha256::digest(&e).to_vec(),
                1 => Sha384::digest(&e).to_vec(),
                _ => Sha512::digest(&e).to_vec(),
            };
            let last = u32::from(*e.last().unwrap_or(&0));
            if round >= 64 && last <= round - 32 {
                break;
            }
        }
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&k[..32]);
    out
}

fn rc4(key: &[u8], data: &mut [u8]) {
    use rc4::consts::*;
    use rc4::{KeyInit, Rc4, StreamCipher};
    macro_rules! apply {
        ($($len:literal => $size:ty),*) => {
            match key.len() {
                $($len => {
                    if let Ok(mut cipher) = Rc4::<$size>::new_from_slice(key) {
                        cipher.apply_keystream(data);
                    }
                })*
                _ => {}
            }
        };
    }
    apply!(5 => U5, 6 => U6, 7 => U7, 8 => U8, 9 => U9, 10 => U10, 11 => U11, 12 => U12,
        13 => U13, 14 => U14, 15 => U15, 16 => U16, 32 => U32);
}

fn contains_ref(object: &Object) -> bool {
    match object {
        Object::Ref(..) => true,
        Object::Array(items) => items.iter().any(contains_ref),
        Object::Dict(dict) => dict.0.iter().any(|(_, value)| contains_ref(value)),
        _ => false,
    }
}

fn has_crypt_filter(dict: &Dict) -> bool {
    match dict.get("Filter") {
        Some(Object::Name(name)) => decode_name(name) == b"Crypt",
        Some(Object::Array(items)) => items
            .iter()
            .any(|item| matches!(item, Object::Name(name) if decode_name(name) == b"Crypt")),
        _ => false,
    }
}

/// The object numbers an object stream holds, in order.
fn object_stream_members(dict: &Dict, data: &[u8]) -> Result<Vec<u32>, EncryptionError> {
    let flate = match dict.get("Filter") {
        None => false,
        Some(Object::Name(name)) if decode_name(name) == b"FlateDecode" => true,
        Some(Object::Array(items))
            if items.len() == 1
                && matches!(&items[0], Object::Name(name) if decode_name(name) == b"FlateDecode") =>
        {
            true
        }
        _ => {
            return Err(EncryptionError::Unsupported(
                "object streams with this filter",
            ))
        }
    };
    if dict.get("DecodeParms").is_some() {
        return Err(EncryptionError::Unsupported(
            "object streams with a predictor",
        ));
    }
    let decoded;
    let content = if flate {
        decoded = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(data, 1 << 30)
            .map_err(|_| EncryptionError::Unreadable("an object stream that does not inflate"))?;
        &decoded[..]
    } else {
        data
    };
    let count = dict
        .int("N")
        .and_then(|n| usize::try_from(n).ok())
        .ok_or(EncryptionError::Unreadable("an object stream without /N"))?;
    let mut parser = Parser::new(content, 0);
    let mut members = Vec::with_capacity(count.min(1 << 16));
    for _ in 0..count {
        parser.skip_whitespace();
        let num = parser.unsigned();
        parser.skip_whitespace();
        let offset = parser.unsigned();
        match (num.and_then(|n| u32::try_from(n).ok()), offset) {
            (Some(num), Some(_)) => members.push(num),
            _ => return Err(EncryptionError::Unreadable("an object stream header")),
        }
    }
    Ok(members)
}

/// The source's /Encrypt dictionary and /ID[0], read through its
/// cross-reference the way PDFium reads them (src/xref.rs): never from
/// text no section points at.
fn source_encryption_entries(source: &[u8]) -> Result<(Dict, Vec<u8>), EncryptionError> {
    let xref = CrossReference::read(source).map_err(EncryptionError::Unreadable)?;
    let encrypt = xref.trailer("Encrypt").ok_or(EncryptionError::Unreadable(
        "no /Encrypt in the source's trailer",
    ))?;
    let encrypt = match xref.resolve(encrypt).map_err(EncryptionError::Unreadable)? {
        Object::Dict(dict) => dict,
        _ => {
            return Err(EncryptionError::Unreadable(
                "the source's /Encrypt is not a dictionary",
            ))
        }
    };
    let id0 = match xref.trailer("ID") {
        // A file without /ID derives its key from an empty one.
        None => Vec::new(),
        Some(id) => match xref.resolve(id).map_err(EncryptionError::Unreadable)? {
            Object::Array(items) => match items.into_iter().next() {
                Some(Object::String(first)) => first,
                _ => return Err(EncryptionError::Unreadable("the source's /ID")),
            },
            _ => return Err(EncryptionError::Unreadable("the source's /ID")),
        },
    };
    Ok((encrypt, id0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_syntax::parse_file;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    const ID0: &str = "00112233445566778899aabbccddeeff";

    /// /Encrypt dictionaries whose /O, /U, /OE, /UE come from pypdf 6.19
    /// (an independent implementation), for user "user-pw", owner
    /// "owner-pw", P -3904, ID0 above; R5/R6 under the file key 00..1f.
    fn vector(revision: i64) -> (Dict, Vec<u8>) {
        let mut dict = Dict::default();
        dict.set("Filter", Object::name("Standard"));
        dict.set("P", Object::number(-3904));
        dict.set("R", Object::number(revision));
        let (o, u, key) = match revision {
            2 => {
                dict.set("V", Object::number(1));
                (
                    "02d93f9ace57134d64279e6be3038b6dcd4be17322f995e53e5742acfe50821c",
                    "d898e1aab6bfe6cc9dbfbdc45ea8a39181a1c3d003246f2cb99d86385c26a236",
                    "546cc650a0",
                )
            }
            3 => {
                dict.set("V", Object::number(2));
                dict.set("Length", Object::number(128));
                (
                    "93517ac0a77c8c723c49bd2f1024e0989d69409a0e69b142a4ee203bbeee7aa6",
                    "dd1333d55d643d3c4d43c9800a8815ea28bf4e5e4e758a4164004e56fffa0108",
                    "0c175f37db67b28a5953f83391838c18",
                )
            }
            4 => {
                // AES-128 with EncryptMetadata false: the key's 0xFFFFFFFF tail.
                dict.set("V", Object::number(4));
                dict.set("EncryptMetadata", Object::Bool(false));
                let mut std_cf = Dict::default();
                std_cf.set("CFM", Object::name("AESV2"));
                std_cf.set("Length", Object::number(16));
                let mut cf = Dict::default();
                cf.set("StdCF", Object::Dict(std_cf));
                dict.set("CF", Object::Dict(cf));
                dict.set("StmF", Object::name("StdCF"));
                dict.set("StrF", Object::name("StdCF"));
                (
                    "93517ac0a77c8c723c49bd2f1024e0989d69409a0e69b142a4ee203bbeee7aa6",
                    "6a855dd6c321e5eee392dc41c12751cc28bf4e5e4e758a4164004e56fffa0108",
                    "2c25a446a8432165ec47a1492d2499ec",
                )
            }
            5 | 6 => {
                dict.set("V", Object::number(5));
                dict.set("Length", Object::number(256));
                let mut std_cf = Dict::default();
                std_cf.set("CFM", Object::name("AESV3"));
                std_cf.set("Length", Object::number(32));
                let mut cf = Dict::default();
                cf.set("StdCF", Object::Dict(std_cf));
                dict.set("CF", Object::Dict(cf));
                dict.set("StmF", Object::name("StdCF"));
                dict.set("StrF", Object::name("StdCF"));
                let (o, u, oe, ue) = if revision == 5 {
                    (
                        "b5bf91aaf02f76bebf008029abf945ec44593f4bf06987ec62a357edb8763c46869f8054a5aa1974e6fa09d1cecbba4a",
                        "bdfcb4ebb8358cb93a6189c9984804f2921670020b56983946bccdc7647ede011e97890c08ae89aa72298a81e766b632",
                        "e9eb6331cde57d673bea04280f1fb008cd9772eb5eb8704758f0c2bcff06a6aa",
                        "de1389e5be918a63b4dafe6195d6022bdb25ebebbeb0bc4c68226374297d4118",
                    )
                } else {
                    (
                        "c93220a3696a56be2c8f93825f1df0b7f25134d3f17b3dc740e218d43b7a8809b8e3e65f810ab773dd13e938689dd31b",
                        "fa531e7bca4959878e3ed7e4b8d2fb057ee43c871a98d9071925e8ddd5d5480e497c4dba6f1c91867f7b34b1106f0b3f",
                        "e698455291ab80bdba9b129b6c3da67b49f90be9b120d6e4b820290c573d2caf",
                        "5556889904610d616b3ad5ad955e88d07bdb3eb9f40393edbbe22675d2238cc7",
                    )
                };
                dict.set("OE", Object::String(hex(oe)));
                dict.set("UE", Object::String(hex(ue)));
                (
                    o,
                    u,
                    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
                )
            }
            _ => unreachable!(),
        };
        dict.set("O", Object::String(hex(o)));
        dict.set("U", Object::String(hex(u)));
        (dict, hex(key))
    }

    fn unlock(revision: i64, password: &str) -> Result<SourceEncryption, EncryptionError> {
        let (dict, _) = vector(revision);
        SourceEncryption::from_parts(dict, hex(ID0), b"1.7".to_vec(), password)
    }

    #[test]
    fn rc4_matches_rfc_6229() {
        let mut data = [0u8; 8];
        rc4(&[1, 2, 3, 4, 5], &mut data);
        assert_eq!(data, [0xb2, 0x39, 0x63, 0x05, 0xf0, 0x3d, 0xc0, 0x27]);
        let mut data = [0u8; 8];
        rc4(&hex("0102030405060708090a0b0c0d0e0f10"), &mut data);
        assert_eq!(data, [0x9a, 0xc7, 0xcc, 0x9a, 0x60, 0x9d, 0x1e, 0xf7]);
    }

    #[test]
    fn both_passwords_unlock_the_same_key_as_pypdf_derives_it() {
        for revision in [2, 3, 4, 5, 6] {
            let (_, key) = vector(revision);
            for password in ["user-pw", "owner-pw"] {
                let unlocked = unlock(revision, password)
                    .unwrap_or_else(|e| panic!("R{revision} {password}: {e}"));
                assert_eq!(unlocked.key, key, "R{revision} {password}");
            }
        }
    }

    #[test]
    fn a_wrong_or_missing_password_does_not_unlock() {
        for revision in [2, 3, 4, 5, 6] {
            for password in ["", "user-pW", "owner-pw "] {
                assert_eq!(
                    unlock(revision, password).map(|_| ()),
                    Err(EncryptionError::NotUnlocked),
                    "R{revision} {password:?}"
                );
            }
        }
    }

    #[test]
    fn the_error_message_names_neither_password_nor_damage() {
        // classifyPdfOpenError reads those words as open failures, and no
        // message may carry what the reader typed.
        for error in [
            EncryptionError::NotUnlocked,
            EncryptionError::Unsupported("x"),
            EncryptionError::Unreadable("x"),
        ] {
            let text = error.to_string().to_lowercase();
            assert!(text.starts_with("re-encryption unsupported"));
            assert!(!text.contains("password") && !text.contains("damaged"));
        }
    }

    #[test]
    fn handlers_it_cannot_reproduce_are_refused() {
        let refuse = |edit: &dyn Fn(&mut Dict)| {
            let (mut dict, _) = vector(4);
            edit(&mut dict);
            match SourceEncryption::from_parts(dict, hex(ID0), b"1.7".to_vec(), "user-pw") {
                Err(EncryptionError::Unsupported(_)) => {}
                other => panic!("expected a refusal, got {other:?}"),
            }
        };
        refuse(&|d| d.set("Filter", Object::name("Adobe.PubSec")));
        refuse(&|d| d.set("V", Object::number(3)));
        refuse(&|d| d.set("R", Object::number(7)));
        refuse(&|d| d.set("StrF", Object::name("Identity")));
        refuse(&|d| d.set("EFF", Object::name("Other")));
        refuse(&|d| d.set("P", Object::Ref(9, 0)));
        refuse(&|d| {
            let mut cf = d.get("CF").unwrap().as_dict().unwrap().clone();
            let mut std_cf = cf.get("StdCF").unwrap().as_dict().unwrap().clone();
            std_cf.set("CFM", Object::name("None"));
            cf.set("StdCF", Object::Dict(std_cf));
            d.set("CF", Object::Dict(cf));
        });
    }

    #[test]
    fn non_ascii_passwords_are_tried_as_latin_1_and_as_utf_8() {
        assert_eq!(password_candidates("abc"), vec![b"abc".to_vec()]);
        assert_eq!(
            password_candidates("caf\u{e9}"),
            vec![b"caf\xe9".to_vec(), "caf\u{e9}".as_bytes().to_vec()]
        );
        assert_eq!(
            password_candidates("密码"),
            vec!["密码".as_bytes().to_vec()]
        );
    }

    const PLAIN: &[u8] = b"%PDF-1.7\n\
1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>\nendobj\n\
2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\
3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Annots [<< /Subtype /Text /Contents <FEFF00480069> /T (Reviewer) >>] >>\nendobj\n\
4 0 obj\n<< /Length 13 >>\nstream\nBT (Hi) Tj ET\nendstream\nendobj\n\
5 0 obj\n<< /Type /Metadata /Subtype /XML /Length 9 >>\nstream\n<x:xmp/>\n\nendstream\nendobj\n\
6 0 obj\n<< /Title (Locked) /ByteRange [0 1 2 3] /Contents <00ff> >>\nendobj\n\
xref\n0 7\n0000000000 65535 f \ntrailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R /ID [<aa> <bb>] >>\nstartxref\n0\n%%EOF\n";

    fn find(file: &crate::pdf_syntax::ParsedFile, num: u32) -> &crate::pdf_syntax::IndirectObject {
        file.objects.iter().find(|o| o.num == num).unwrap()
    }

    #[test]
    fn an_encrypted_export_decrypts_back_to_the_plaintext_and_keeps_the_source_entries() {
        for revision in [2, 3, 4, 5, 6] {
            let handler = unlock(revision, "user-pw").unwrap();
            let out = handler.encrypt_file(PLAIN).unwrap();
            let file = parse_file(&out).unwrap();
            let method = handler.streams;

            // The trailer: the source's /Encrypt as an indirect object, /ID[0] kept.
            let Some(Object::Ref(encrypt_num, 0)) = file.trailer.get("Encrypt").cloned() else {
                panic!("R{revision}: no indirect /Encrypt");
            };
            assert_eq!(
                find(&file, encrypt_num).value,
                Object::Dict(vector(revision).0)
            );
            let Some(Object::Array(id)) = file.trailer.get("ID") else {
                panic!()
            };
            assert_eq!(id[0], Object::String(hex(ID0)));
            assert_eq!(file.trailer.get("Info"), Some(&Object::Ref(6, 0)));

            // Content stream and annotation strings encrypted, and back.
            let content = find(&file, 4);
            assert_ne!(content.stream.as_deref(), Some(&b"BT (Hi) Tj ET"[..]));
            assert_eq!(
                handler.decrypt_bytes(method, 4, 0, content.stream.as_ref().unwrap()),
                b"BT (Hi) Tj ET"
            );
            let page = find(&file, 3).value.as_dict().unwrap();
            let Some(Object::Array(annots)) = page.get("Annots") else {
                panic!()
            };
            let note = annots[0].as_dict().unwrap();
            let Some(Object::String(contents)) = note.get("Contents") else {
                panic!()
            };
            assert_eq!(
                handler.decrypt_bytes(handler.strings, 3, 0, contents),
                hex("feff00480069")
            );

            // The XMP stays in the clear only when /EncryptMetadata is false.
            let xmp = find(&file, 5).stream.clone().unwrap();
            if revision == 4 {
                assert_eq!(xmp, b"<x:xmp/>\n");
            } else {
                assert_eq!(handler.decrypt_bytes(method, 5, 0, &xmp), b"<x:xmp/>\n");
            }
            assert_eq!(
                find(&file, 5).value.as_dict().unwrap().int("Length"),
                Some(xmp.len() as i64)
            );

            // A signature's /Contents stays as it was; its other strings do not.
            let signature = find(&file, 6).value.as_dict().unwrap();
            assert_eq!(
                signature.get("Contents"),
                Some(&Object::String(vec![0, 0xff]))
            );
            let Some(Object::String(title)) = signature.get("Title") else {
                panic!()
            };
            assert_eq!(
                handler.decrypt_bytes(handler.strings, 6, 0, title),
                b"Locked"
            );

            // The classic cross-reference table points at every object.
            let xref = out.windows(6).rposition(|w| w == b"\nxref\n").unwrap() + 1;
            assert!(out.ends_with(format!("startxref\n{xref}\n%%EOF\n").as_bytes()));
            let size = file.trailer.int("Size").unwrap() as usize;
            let rows = xref + format!("xref\n0 {size}\n").len();
            for object in &file.objects {
                let header = format!("\n{} {} obj\n", object.num, object.gen);
                let offset = out
                    .windows(header.len())
                    .position(|w| w == header.as_bytes())
                    .unwrap()
                    + 1;
                let row = rows + 20 * object.num as usize;
                assert_eq!(
                    &out[row..row + 20],
                    format!("{offset:010} {:05} n\r\n", object.gen).as_bytes(),
                    "R{revision} obj {}",
                    object.num
                );
            }
        }
    }

    #[test]
    fn object_streams_are_encrypted_whole_and_listed_in_a_cross_reference_stream() {
        let members = b"1 0 2 52 ";
        let body = b"<< /Type /Catalog /Pages 2 0 R /Lang (en) >>\n      << /Type /Pages /Kids [] /Count 0 >>";
        let mut objstm = members.to_vec();
        objstm.extend_from_slice(body);
        let packed = miniz_oxide::deflate::compress_to_vec_zlib(&objstm, 6);
        let xref_rows = [0u8; 4];
        let mut plain = b"%PDF-1.7\n".to_vec();
        plain.extend_from_slice(
            format!("3 0 obj\n<< /Type /ObjStm /N 2 /First {} /Filter /FlateDecode /Length {} >>\nstream\n", members.len(), packed.len()).as_bytes(),
        );
        plain.extend_from_slice(&packed);
        plain.extend_from_slice(b"\nendstream\nendobj\n");
        plain.extend_from_slice(
            format!(
                "4 0 obj\n<< /Type /XRef /Size 5 /Root 1 0 R /W [1 2 1] /Length {} >>\nstream\n",
                xref_rows.len()
            )
            .as_bytes(),
        );
        plain.extend_from_slice(&xref_rows);
        plain.extend_from_slice(b"\nendstream\nendobj\nstartxref\n9\n%%EOF\n");

        let handler = unlock(6, "owner-pw").unwrap();
        let out = handler.encrypt_file(&plain).unwrap();
        let file = parse_file(&out).unwrap();
        // The old cross-reference stream is gone, the new one is in the clear.
        let is_xref = |o: &&crate::pdf_syntax::IndirectObject| {
            o.value.as_dict().and_then(|d| d.name("Type")).as_deref() == Some(b"XRef")
        };
        assert_eq!(file.objects.iter().filter(is_xref).count(), 1);
        let xref = file
            .objects
            .iter()
            .find(|o| o.value.as_dict().unwrap().name("Type").as_deref() == Some(b"XRef"))
            .unwrap();
        let rows =
            miniz_oxide::inflate::decompress_to_vec_zlib(xref.stream.as_ref().unwrap()).unwrap();
        let width = xref.value.as_dict().unwrap().get("W").cloned();
        let Some(Object::Array(w)) = width else {
            panic!()
        };
        let row = 1 + w[1].as_int().unwrap() as usize + 2;
        // Objects 1 and 2 are entries 0 and 1 of object stream 3.
        assert_eq!(rows[row], 2);
        assert_eq!(&rows[row * 2 - 2..row * 2], &[0, 0]);
        assert_eq!(rows[row * 2], 2);
        assert_eq!(&rows[row * 3 - 2..row * 3], &[0, 1]);
        assert!(file.trailer.get("Encrypt").is_some());
        // The object stream decrypts to what it held, its strings untouched inside.
        let objstm_out = find(&file, 3);
        let decrypted =
            handler.decrypt_bytes(Method::Aes256, 3, 0, objstm_out.stream.as_ref().unwrap());
        assert_eq!(decrypted, packed);
    }

    #[test]
    fn object_numbers_and_sizes_cannot_make_the_cross_reference_overflow_or_balloon() {
        // What can go wrong with a plaintext's numbering, which the node
        // and CLI bindings take from any caller: a /Size that sizes the new
        // table instead of the objects present; an object number at the top
        // of the range overflowing the /Encrypt and /XRef numbers after it,
        // or far past the objects present filling gigabytes of free
        // entries; object 0, the head of the free list, written in use.
        let handler = unlock(4, "user-pw").unwrap();
        let text = String::from_utf8_lossy(PLAIN).into_owned();
        let bogus_size = text.replace("<< /Size 7 /Root", "<< /Size 4294967295 /Root");
        let out = handler.encrypt_file(bogus_size.as_bytes()).unwrap();
        assert!(out.len() < PLAIN.len() * 4, "{} bytes", out.len());
        assert_eq!(parse_file(&out).unwrap().trailer.int("Size"), Some(8));

        for num in [u32::MAX, u32::MAX - 1, 9_000_000, 0] {
            let renumbered = text.replace("6 0 obj", &format!("{num} 0 obj"));
            assert!(
                handler.encrypt_file(renumbered.as_bytes()).is_err(),
                "object {num}"
            );
        }
    }

    #[test]
    fn an_already_encrypted_or_unreadable_export_is_refused() {
        let handler = unlock(4, "user-pw").unwrap();
        let encrypted = handler.encrypt_file(PLAIN).unwrap();
        assert!(matches!(
            handler.encrypt_file(&encrypted),
            Err(EncryptionError::Unreadable(_))
        ));
        assert!(matches!(
            handler.encrypt_file(b"not a pdf"),
            Err(EncryptionError::Unreadable(_))
        ));
    }

    #[test]
    fn the_source_entries_are_found_through_prev_in_streams_and_when_indirect() {
        let (dict, _) = vector(3);
        let mut encrypt = Vec::new();
        write_object(&mut encrypt, &Object::Dict(dict.clone()));
        let encrypt = String::from_utf8(encrypt).unwrap();
        // An indirect /Encrypt in a cross-reference stream's dictionary,
        // superseded by an incremental update whose trailer lacks both.
        let head = "%PDF-1.5\n";
        let object = format!("7 0 obj\n{encrypt}\nendobj\n");
        let first_xref = head.len() + object.len();
        let mut rows = Vec::new();
        for offset in [head.len(), first_xref] {
            rows.push(1u8);
            rows.extend_from_slice(&(offset as u32).to_be_bytes());
            rows.push(0);
        }
        let mut source = format!(
            "{head}{object}9 0 obj\n<< /Type /XRef /Size 10 /W [1 4 1] /Index [7 1 9 1] /Encrypt 7 0 R /ID [<{ID0}> <00>] /Length {} >>\nstream\n",
            rows.len()
        )
        .into_bytes();
        source.extend_from_slice(&rows);
        source.extend_from_slice(
            format!("\nendstream\nendobj\nstartxref\n{first_xref}\n%%EOF\n").as_bytes(),
        );
        let second_xref = source.len();
        source.extend_from_slice(
            format!("xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 10 /Prev {first_xref} >>\nstartxref\n{second_xref}\n%%EOF\n").as_bytes(),
        );
        let (found, id0) = source_encryption_entries(&source).unwrap();
        assert_eq!(found, dict);
        assert_eq!(id0, hex(ID0));
        let unlocked = SourceEncryption::from_source(&source, "user-pw").unwrap();
        assert_eq!(unlocked.key, vector(3).1);
        assert_eq!(unlocked.source_version, b"1.5".to_vec());
    }
}
