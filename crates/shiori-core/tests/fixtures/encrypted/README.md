# Encrypted fixtures

Password-protected PDFs for the re-encryption tests
(`crates/shiori-core/src/encryption.rs`, `tests/core.rs`,
`crates/shiori-core-node/test/encryptedExport.test.ts`,
`crates/shiori-core-wasm/test/core.test.ts`).

Regenerate with:

```bash
uv run --script crates/shiori-core/tests/fixtures/encrypted/make-encrypted-fixtures.py
```

The script pins pypdf 6.19.0, a third implementation of the Standard security
handler beside PDFium and shiori-core. Keys, salts and `/ID` are random, so a
rerun writes different bytes with the same meaning; nothing asserts on bytes.

Every file holds the same document: two Letter pages reading "Secret page
one" and "Secret page two" in Helvetica, a Text note on page 1 with
`/Contents` "Encrypted note 加密" and `/T` "Reviewer", the Info title
"Locked title 秘密", an XMP stream titled "Locked title XMP", and an
attachment `notes.txt` ("attached notes 附件").

Owner password `owner-pw` throughout; user password `user-pw` unless noted.

| File | Handler | /P for the user password |
| --- | --- | --- |
| `rc4-40.pdf` | V1 R2, RC4 40-bit | all |
| `rc4-128.pdf` | V2 R3, RC4 128-bit | all |
| `r4-rc4.pdf` | V4 R4, crypt filter `/V2` (RC4) | all |
| `aes-128.pdf` | V4 R4, `/AESV2` | all |
| `aes-128-nometa.pdf` | V4 R4, `/AESV2`, `/EncryptMetadata false` | all |
| `aes-256-r5.pdf` | V5 R5 (deprecated AES-256) | all |
| `aes-256.pdf` | V5 R6, `/AESV3` | all |
| `aes-256-nometa.pdf` | V5 R6, `/EncryptMetadata false` | all |
| `restricted.pdf` | V5 R6 | print only |
| `annotate-only.pdf` | V4 R4, `/AESV2` | print and annotate |
| `empty-user.pdf` | V5 R6, empty user password | print only |
| `cjk-password.pdf` | V5 R6, user password `密码パス` (UTF-8) | all |
| `latin1-password.pdf` | V2 R3, user password `café` (Latin-1) | all |

pypdf writes neither a V4 handler with an RC4 crypt filter nor
`/EncryptMetadata false`; the script builds those two through pypdf's
`Encryption` class and leaves the XMP stream in the clear itself.
