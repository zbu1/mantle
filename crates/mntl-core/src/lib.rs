//! Core cryptography engine and note formats for Mantle's `.mntl` and
//! `.mntl.enc` files.
//!
//! This crate handles two note formats:
//!
//! - **`.mntl` (unencrypted)**: a plain UTF-8 Markdown file with a YAML
//!   frontmatter header ([`NoteFrontmatter`]) at the top, exactly like a
//!   standard Obsidian/Jekyll/Hugo note. It is human-readable and editable in
//!   any text editor, and diffs cleanly in version control
//!   ([`encode_unencrypted_note`] / [`decode_unencrypted_note`]).
//! - **`.mntl.enc` (encrypted)**: a zero-knowledge encrypted binary envelope.
//!   A user password is stretched into a 256-bit Key Encryption Key (KEK)
//!   with Argon2id ([`derive_kek`]). Each note is encrypted with a freshly
//!   generated Data Encryption Key (DEK) using XChaCha20-Poly1305, and the
//!   DEK itself is wrapped with the KEK using AES-KW
//!   ([`encrypt_note`] / [`decrypt_note`]). The envelope is a small binary
//!   container: magic bytes, a length-prefixed JSON [`EncryptedHeader`], and
//!   the ciphertext. The header is passed to the cipher as associated data
//!   (AAD), so any tampering with it invalidates decryption.
//!
//! # `.mntl` frontmatter format
//!
//! ```text
//! ---
//! v: 2
//! ---
//! # My note
//!
//! Body content in Markdown.
//! ```
//!
//! # `.mntl.enc` envelope layout
//!
//! ```text
//! +----------------+----------------------+------------------+-----------------+
//! | magic (4 bytes)| header_len (4 bytes) | header (JSON)    | ciphertext      |
//! | "MENC"         | little-endian u32    | header_len bytes | remaining bytes |
//! +----------------+----------------------+------------------+-----------------+
//! ```
//!
//! # Examples
//!
//! Encrypting and decrypting a note:
//!
//! ```
//! use mntl_core::{derive_kek, encrypt_note, decrypt_note};
//!
//! let salt = b"a unique per-user salt";
//! let kek = derive_kek("correct horse battery staple", salt)?;
//!
//! let blob = encrypt_note(&kek[..], salt, "profile-id", b"secret note contents")?;
//! let plaintext = decrypt_note(&kek[..], &blob)?;
//!
//! assert_eq!(plaintext, b"secret note contents");
//! # Ok::<(), mntl_core::MntlError>(())
//! ```
//!
//! Encoding and decoding an unencrypted note:
//!
//! ```
//! use mntl_core::{encode_unencrypted_note, decode_unencrypted_note};
//!
//! let file = encode_unencrypted_note("# Grocery list\n\n- Milk\n- Eggs")?;
//! assert!(file.starts_with("---\nv: 2\n---\n"));
//!
//! let content = decode_unencrypted_note(&file)?;
//! assert_eq!(content, "# Grocery list\n\n- Milk\n- Eggs");
//! # Ok::<(), mntl_core::MntlError>(())
//! ```

pub mod error;
pub mod header;

use aes_kw::KekAes256;
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

pub use error::MntlError;
pub use header::{
    CryptoMeta, EncryptedHeader, KdfParams, NoteFrontmatter, CURRENT_VERSION, HEADER_OFFSET,
    MAGIC_MENC,
};

/// Derive a 256-bit Key Encryption Key (KEK) using Argon2id with default KDF parameters.
///
/// Equivalent to [`derive_kek_with_params`] with [`KdfParams::default`].
///
/// # Errors
///
/// Returns [`MntlError::KdfError`] if Argon2 hashing fails (e.g. invalid parameters).
pub fn derive_kek(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, MntlError> {
    derive_kek_with_params(password, salt, &KdfParams::default())
}

/// Derive a 256-bit Key Encryption Key (KEK) using Argon2id with explicit KDF parameters.
///
/// The returned key is wrapped in [`Zeroizing`] so it is scrubbed from memory when dropped.
///
/// # Errors
///
/// Returns [`MntlError::KdfError`] if `params` are invalid or Argon2 hashing fails.
pub fn derive_kek_with_params(
    password: &str,
    salt: &[u8],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, MntlError> {
    let argon2_params = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(32))
        .map_err(|e| MntlError::KdfError(e.to_string()))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2_params);

    let mut kek = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(password.as_bytes(), salt, kek.as_mut_slice())
        .map_err(|e| MntlError::KdfError(e.to_string()))?;

    Ok(kek)
}

/// Encrypt a note payload using XChaCha20-Poly1305 envelope encryption.
///
/// Generates a random 256-bit DEK and a 192-bit Nonce.
/// The DEK is wrapped using AES-KW with the supplied 256-bit KEK.
/// The raw JSON header bytes are passed into the cipher as Associated Data (AD).
///
/// `salt` is recorded in the resulting header's [`CryptoMeta`] so the KEK can
/// be re-derived from the same password on decryption; it is not used
/// directly by this function. `kdf_params` defaults to [`KdfParams::default`];
/// use [`encrypt_note_with_params`] to record different parameters.
///
/// Returns the serialized `.mntl.enc` binary envelope.
///
/// # Errors
///
/// Returns [`MntlError::KeyWrapError`] if `kek` is not 32 bytes or DEK wrapping
/// fails, and [`MntlError::EncryptionFailed`] if the cipher fails.
pub fn encrypt_note(
    kek: &[u8],
    salt: &[u8],
    profile_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, MntlError> {
    encrypt_note_with_params(kek, salt, profile_id, plaintext, &KdfParams::default())
}

/// Encrypt a note payload with explicit KDF parameters recorded in header metadata.
///
/// See [`encrypt_note`] for details; this variant additionally records
/// `kdf_params` in the envelope header so a non-default Argon2id cost can be
/// reproduced when the KEK is re-derived for decryption.
///
/// # Errors
///
/// Returns [`MntlError::KeyWrapError`] if `kek` is not 32 bytes or DEK wrapping
/// fails, and [`MntlError::EncryptionFailed`] if the cipher fails.
pub fn encrypt_note_with_params(
    kek: &[u8],
    salt: &[u8],
    profile_id: &str,
    plaintext: &[u8],
    kdf_params: &KdfParams,
) -> Result<Vec<u8>, MntlError> {
    let kek_array: [u8; 32] = kek
        .try_into()
        .map_err(|_| MntlError::KeyWrapError)?;

    // 1. Generate random 256-bit DEK and 192-bit Nonce
    let mut dek = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(dek.as_mut_slice());

    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);

    // 2. Wrap DEK using AES-KW (AES-256)
    let kw = KekAes256::from(kek_array);
    let mut wrapped_key = vec![0u8; 40]; // 32-byte key wrapped with AES-KW is 40 bytes
    kw.wrap(dek.as_slice(), &mut wrapped_key)
        .map_err(|_| MntlError::KeyWrapError)?;

    // 3. Assemble JSON Header metadata
    let crypto_meta = CryptoMeta {
        iv: BASE64.encode(nonce_bytes),
        salt: BASE64.encode(salt),
        wrapped_key: BASE64.encode(&wrapped_key),
        kdf: kdf_params.clone(),
    };

    let header = EncryptedHeader::new(profile_id, crypto_meta);
    let header_json = serde_json::to_vec(&header)?;

    // 4. Encrypt payload with XChaCha20-Poly1305 using header_json as Associated Data (AD)
    let cipher = XChaCha20Poly1305::new(Key::from_slice(dek.as_slice()));
    let nonce = XNonce::from_slice(&nonce_bytes);
    let payload = Payload {
        msg: plaintext,
        aad: &header_json,
    };

    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|_| MntlError::EncryptionFailed)?;

    // 5. Assemble final binary blob: MAGIC_MENC (4B) + header_len (4B LE) + header_json + ciphertext
    let header_len = u32::try_from(header_json.len()).map_err(|_| MntlError::InvalidHeaderSize)?;
    let mut output = Vec::with_capacity(HEADER_OFFSET + header_json.len() + ciphertext.len());

    output.extend_from_slice(MAGIC_MENC);
    output.extend_from_slice(&header_len.to_le_bytes());
    output.extend_from_slice(&header_json);
    output.extend_from_slice(&ciphertext);

    Ok(output)
}

/// Decrypt an encrypted `.mntl.enc` binary blob.
///
/// Parses the envelope, unwraps the DEK using the supplied KEK,
/// verifies header authenticity via Associated Data (AD), and decrypts the payload.
///
/// `kek` must be the same 32-byte key produced by [`derive_kek`] (or
/// [`derive_kek_with_params`]) for the password and salt recorded in the
/// envelope's header.
///
/// # Errors
///
/// Returns [`MntlError::InvalidHeaderSize`] or [`MntlError::InvalidMagicBytes`]
/// if `mntl_enc_bytes` is malformed, [`MntlError::HeaderParseError`] if the
/// header JSON is invalid (including a missing `crypto` section),
/// [`MntlError::UnsupportedVersion`] for an unrecognized envelope version,
/// [`MntlError::InvalidBase64`] or [`MntlError::InvalidCryptoMetadata`] for
/// malformed metadata fields, [`MntlError::KeyWrapError`] if `kek` is not 32
/// bytes or DEK unwrapping fails, and [`MntlError::DecryptionFailed`] if the
/// ciphertext or header has been tampered with.
pub fn decrypt_note(kek: &[u8], mntl_enc_bytes: &[u8]) -> Result<Vec<u8>, MntlError> {
    if mntl_enc_bytes.len() < HEADER_OFFSET {
        return Err(MntlError::InvalidHeaderSize);
    }

    // 1. Verify Magic Bytes
    if &mntl_enc_bytes[0..4] != MAGIC_MENC {
        return Err(MntlError::InvalidMagicBytes);
    }

    // 2. Extract Header JSON slice and Ciphertext slice
    let header_len = u32::from_le_bytes(
        mntl_enc_bytes[4..8]
            .try_into()
            .map_err(|_| MntlError::InvalidHeaderSize)?,
    ) as usize;

    let header_end = HEADER_OFFSET + header_len;
    if mntl_enc_bytes.len() < header_end {
        return Err(MntlError::InvalidHeaderSize);
    }

    let header_json_bytes = &mntl_enc_bytes[HEADER_OFFSET..header_end];
    let ciphertext = &mntl_enc_bytes[header_end..];

    // 3. Deserialize JSON Header
    let header: EncryptedHeader = serde_json::from_slice(header_json_bytes)?;

    if header.v != CURRENT_VERSION {
        return Err(MntlError::UnsupportedVersion(header.v));
    }

    let crypto = header.crypto;

    // 4. Decode metadata fields from Base64
    let nonce_bytes = BASE64
        .decode(&crypto.iv)
        .map_err(|_| MntlError::InvalidBase64)?;
    let wrapped_key_bytes = BASE64
        .decode(&crypto.wrapped_key)
        .map_err(|_| MntlError::InvalidBase64)?;

    if nonce_bytes.len() != 24 {
        return Err(MntlError::InvalidCryptoMetadata("Invalid nonce length".into()));
    }

    // 5. Unwrap DEK using KEK
    let kek_array: [u8; 32] = kek
        .try_into()
        .map_err(|_| MntlError::KeyWrapError)?;

    let kw = KekAes256::from(kek_array);
    let mut dek = Zeroizing::new([0u8; 32]);
    kw.unwrap(&wrapped_key_bytes, dek.as_mut_slice())
        .map_err(|_| MntlError::KeyWrapError)?;

    // 6. Decrypt ciphertext using XChaCha20-Poly1305 with raw header_json_bytes as AD
    let cipher = XChaCha20Poly1305::new(Key::from_slice(dek.as_slice()));
    let nonce = XNonce::from_slice(&nonce_bytes);
    let payload = Payload {
        msg: ciphertext,
        aad: header_json_bytes,
    };

    let plaintext = cipher
        .decrypt(nonce, payload)
        .map_err(|_| MntlError::DecryptionFailed)?;

    Ok(plaintext)
}

/// The `---\n` delimiter line that opens and closes a `.mntl` frontmatter block.
const FRONTMATTER_DELIM: &str = "---";

/// Split a `.mntl` file into its raw frontmatter YAML and body text.
///
/// Expects the file to start with a line containing exactly `---`, followed
/// by the frontmatter, followed by another line containing exactly `---`.
/// Everything after that closing delimiter's newline is the body.
fn split_frontmatter(note: &str) -> Result<(&str, &str), MntlError> {
    let first_line_len = note.find('\n').ok_or(MntlError::MissingFrontmatter)?;
    if note[..first_line_len].trim_end_matches('\r') != FRONTMATTER_DELIM {
        return Err(MntlError::MissingFrontmatter);
    }

    let frontmatter_start = first_line_len + 1;
    let mut offset = frontmatter_start;

    loop {
        let line_len = note[offset..].find('\n').ok_or(MntlError::MissingFrontmatter)?;
        let line = note[offset..offset + line_len].trim_end_matches('\r');

        if line == FRONTMATTER_DELIM {
            let frontmatter = &note[frontmatter_start..offset];
            let body = &note[offset + line_len + 1..];
            return Ok((frontmatter, body));
        }

        offset += line_len + 1;
    }
}

/// Encode an unencrypted note into a `.mntl` text file.
///
/// Prepends a YAML frontmatter block (see [`NoteFrontmatter`]) recording the
/// current format version, followed by `content` verbatim as the file body.
/// The result is plain UTF-8 text: readable and editable in any text editor,
/// and diffs line-by-line in version control.
///
/// # Errors
///
/// Returns [`MntlError::FrontmatterParseError`] if the frontmatter header
/// fails to serialize (not expected to happen in practice).
pub fn encode_unencrypted_note(content: &str) -> Result<String, MntlError> {
    let frontmatter = NoteFrontmatter::default();
    let yaml = serde_yaml::to_string(&frontmatter)?;
    let yaml = yaml.trim_end_matches('\n');

    Ok(format!("{FRONTMATTER_DELIM}\n{yaml}\n{FRONTMATTER_DELIM}\n{content}"))
}

/// Decode a `.mntl` text file into its note body, discarding the frontmatter.
///
/// # Errors
///
/// Returns [`MntlError::MissingFrontmatter`] if `note` does not start with a
/// well-formed `---` frontmatter block, [`MntlError::FrontmatterParseError`]
/// if the frontmatter YAML is invalid, and [`MntlError::UnsupportedVersion`]
/// if its `v` field does not match [`CURRENT_VERSION`].
pub fn decode_unencrypted_note(note: &str) -> Result<String, MntlError> {
    let (frontmatter, body) = split_frontmatter(note)?;
    let header: NoteFrontmatter = serde_yaml::from_str(frontmatter)?;

    if header.v != CURRENT_VERSION {
        return Err(MntlError::UnsupportedVersion(header.v));
    }

    Ok(body.to_string())
}

/// Extract just the frontmatter header of a `.mntl` text file, without
/// allocating or returning the (potentially large) note body.
///
/// Useful for indexing or listing notes without paying the cost of reading
/// the full body. Unlike [`decode_unencrypted_note`], this does not validate
/// the format version, so it can inspect notes written by a newer version of
/// this crate.
///
/// # Errors
///
/// Returns [`MntlError::MissingFrontmatter`] if `note` does not start with a
/// well-formed `---` frontmatter block, and [`MntlError::FrontmatterParseError`]
/// if the frontmatter YAML is invalid.
pub fn extract_unencrypted_header(note: &str) -> Result<NoteFrontmatter, MntlError> {
    let (frontmatter, _) = split_frontmatter(note)?;
    let header: NoteFrontmatter = serde_yaml::from_str(frontmatter)?;
    Ok(header)
}

/// Fast header extraction from a `.mntl.enc` envelope without decrypting the payload.
///
/// Useful for indexing or listing notes (e.g. reading `credential_profile`)
/// without paying the cost of decryption.
///
/// # Errors
///
/// Returns [`MntlError::InvalidHeaderSize`] if `mntl_enc_bytes` is truncated,
/// [`MntlError::InvalidMagicBytes`] if it does not start with [`MAGIC_MENC`],
/// and [`MntlError::HeaderParseError`] if the header JSON is invalid.
pub fn extract_encrypted_header(mntl_enc_bytes: &[u8]) -> Result<EncryptedHeader, MntlError> {
    if mntl_enc_bytes.len() < HEADER_OFFSET {
        return Err(MntlError::InvalidHeaderSize);
    }

    if &mntl_enc_bytes[0..4] != MAGIC_MENC {
        return Err(MntlError::InvalidMagicBytes);
    }

    let header_len = u32::from_le_bytes(
        mntl_enc_bytes[4..8]
            .try_into()
            .map_err(|_| MntlError::InvalidHeaderSize)?,
    ) as usize;

    let header_end = HEADER_OFFSET + header_len;
    if mntl_enc_bytes.len() < header_end {
        return Err(MntlError::InvalidHeaderSize);
    }

    let header_json_bytes = &mntl_enc_bytes[HEADER_OFFSET..header_end];
    let header: EncryptedHeader = serde_json::from_slice(header_json_bytes)?;

    Ok(header)
}
