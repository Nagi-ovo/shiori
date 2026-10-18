# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf==6.19.0", "cryptography"]
# ///
"""Regenerates the encrypted fixtures beside this file (see README.md).

Run: uv run --script crates/shiori-core/tests/fixtures/encrypted/make-encrypted-fixtures.py

pypdf is a third implementation of the Standard security handler, apart from
PDFium (which reads the fixtures in the app) and shiori-core's re-encryption
(which the tests check against both). Keys, salts and /ID are random, so each
run writes different bytes with the same meaning.
"""

from pathlib import Path

from pypdf import PdfWriter
from pypdf._encryption import Encryption, EncryptAlgorithm
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    StreamObject,
    TextStringObject,
)

HERE = Path(__file__).parent
USER = "user-pw"
OWNER = "owner-pw"

# /P: bits 1-2 clear, 7-8 and 13-32 set (R>=3), then the permission bits.
NONE = -3904  # 0xFFFFF0C0
PRINT = 1 << 2
MODIFY = 1 << 3
COPY = 1 << 4
ANNOTATE = 1 << 5
FORMS = 1 << 8
ASSEMBLE = 1 << 10
ALL = NONE | PRINT | MODIFY | COPY | ANNOTATE | FORMS | (1 << 9) | ASSEMBLE | (1 << 11)

XMP = """<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Locked title XMP</rdf:li></rdf:Alt></dc:title>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>"""


def document() -> PdfWriter:
    """Two Letter pages of Helvetica text, a Text note with CJK /Contents,
    an Info title, an XMP stream and an attachment."""
    writer = PdfWriter()
    font = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
                NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
            }
        )
    )
    for text in ("Secret page one", "Secret page two"):
        page = writer.add_blank_page(612, 792)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        content = DecodedStreamObject()
        content.set_data(f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET".encode("latin-1"))
        page[NameObject("/Contents")] = writer._add_object(content)
    writer.add_annotation(
        0,
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Annot"),
                NameObject("/Subtype"): NameObject("/Text"),
                NameObject("/Rect"): ArrayObject([FloatObject(v) for v in (72, 600, 92, 620)]),
                NameObject("/Contents"): TextStringObject("Encrypted note 加密"),
                NameObject("/T"): TextStringObject("Reviewer"),
            }
        ),
    )
    writer.add_metadata({"/Title": "Locked title 秘密"})
    xmp = DecodedStreamObject()
    xmp.set_data(XMP.encode("utf-8"))
    xmp[NameObject("/Type")] = NameObject("/Metadata")
    xmp[NameObject("/Subtype")] = NameObject("/XML")
    writer._root_object[NameObject("/Metadata")] = writer._add_object(xmp)
    writer.add_attachment("notes.txt", "attached notes 附件".encode("utf-8"))
    return writer


def encrypt(writer: PdfWriter, user: str, owner: str, permissions: int, algorithm: str, *, rc4_crypt_filter=False, encrypt_metadata=True) -> None:
    """PdfWriter.encrypt, plus the two variants it does not write: a V4
    handler whose crypt filter is RC4 (/CFM /V2), and /EncryptMetadata false
    with the XMP stream left in the clear."""
    if not rc4_crypt_filter and encrypt_metadata:
        writer.encrypt(user, owner, permissions_flag=permissions, algorithm=algorithm)
        return
    writer.generate_file_identifiers()
    v, r, bits = getattr(EncryptAlgorithm, algorithm.replace("-", "_"))
    crypt = "/V2" if rc4_crypt_filter else ("/AESV2" if v == 4 else "/AESV3")
    if rc4_crypt_filter:
        v, r, bits = 4, 4, 128
    encryption = Encryption(
        V=v, R=r, Length=bits, P=permissions, entry=DictionaryObject(),
        EncryptMetadata=encrypt_metadata, first_id_entry=writer._ID[0],
        StmF=crypt, StrF=crypt, EFF=crypt, values=None,
    )
    entry = encryption.write_entry(user, owner)
    if not encrypt_metadata:
        entry[NameObject("/EncryptMetadata")] = BooleanObject(False)
        encrypt_object = encryption.encrypt_object

        def skip_metadata(obj, idnum, generation):
            if isinstance(obj, StreamObject) and obj.get("/Type") == "/Metadata":
                return obj
            return encrypt_object(obj, idnum, generation)

        encryption.encrypt_object = skip_metadata
    writer._encryption = encryption
    writer._add_object(entry)
    writer._encrypt_entry = entry


VARIANTS = {
    # name: (user, owner, /P, algorithm, extra)
    "rc4-40": (USER, OWNER, ALL, "RC4-40", {}),
    "rc4-128": (USER, OWNER, ALL, "RC4-128", {}),
    "r4-rc4": (USER, OWNER, ALL, "RC4-128", {"rc4_crypt_filter": True}),
    "aes-128": (USER, OWNER, ALL, "AES-128", {}),
    "aes-128-nometa": (USER, OWNER, ALL, "AES-128", {"encrypt_metadata": False}),
    "aes-256-r5": (USER, OWNER, ALL, "AES-256-R5", {}),
    "aes-256": (USER, OWNER, ALL, "AES-256", {}),
    "aes-256-nometa": (USER, OWNER, ALL, "AES-256", {"encrypt_metadata": False}),
    # Permission-restricted: print only; annotations and printing only.
    "restricted": (USER, OWNER, NONE | PRINT, "AES-256", {}),
    "annotate-only": (USER, OWNER, NONE | PRINT | ANNOTATE, "AES-128", {}),
    # A permission-only file: no user password, print only.
    "empty-user": ("", OWNER, NONE | PRINT, "AES-256", {}),
    # Non-ASCII passwords: UTF-8 for R6, Latin-1 for R3.
    "cjk-password": ("密码パス", OWNER, ALL, "AES-256", {}),
    "latin1-password": ("café", OWNER, ALL, "RC4-128", {}),
}

if __name__ == "__main__":
    for name, (user, owner, permissions, algorithm, extra) in VARIANTS.items():
        writer = document()
        encrypt(writer, user, owner, permissions, algorithm, **extra)
        with open(HERE / f"{name}.pdf", "wb") as out:
            writer.write(out)
        print(f"wrote {name}.pdf")
