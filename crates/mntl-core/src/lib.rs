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
//!   with Argon2id ([`derive_kek_with_params`]), which wraps a per-profile [`MasterKey`].
//!   Each note is encrypted with a freshly generated content encryption key
//!   using XChaCha20-Poly1305, and that key is wrapped with the master key
//!   using AES-KW ([`encrypt_note`] / [`decrypt_note`]). The envelope is a
//!   small binary container: magic bytes, a length-prefixed JSON
//!   [`EncryptedHeader`], and the ciphertext. The header is passed to the
//!   cipher as associated data (AAD), so any tampering with it invalidates
//!   decryption. See the [`keys`] module for the full key hierarchy.
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
//! Creating a credential profile's key material, then encrypting a note under it:
//!
//! ```
//! use mntl_core::{
//!     decrypt_note, derive_kek_with_params, encrypt_note, unwrap_master_key, wrap_master_key,
//!     KdfParams, MasterKey,
//! };
//!
//! // Once, when the profile is created: wrap a fresh master key with a
//! // password-derived KEK. Only `salt` and `wrapped` are stored.
//! let salt = b"a unique per-profile salt";
//! let kek = derive_kek_with_params("correct horse battery staple", salt, &KdfParams::default())?;
//! let master_key = MasterKey::generate()?;
//! let wrapped = wrap_master_key(&kek, &master_key)?;
//!
//! // Later, on unlock: re-derive the KEK and recover the same master key.
//! let kek = derive_kek_with_params("correct horse battery staple", salt, &KdfParams::default())?;
//! let master_key = unwrap_master_key(&kek, &wrapped)?;
//!
//! // Every note in the profile is then sealed under that one master key.
//! let blob = encrypt_note(&master_key, "profile-id", b"secret note contents")?;
//! let plaintext = decrypt_note(&master_key, &blob)?;
//!
//! assert_eq!(&plaintext[..], b"secret note contents");
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
pub mod keys;
pub mod tags;

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
    CryptoMeta, EncryptedHeader, KdfParams, NoteFrontmatter, ENVELOPE_VERSION, HEADER_OFFSET,
    MAGIC_MENC, NOTE_VERSION,
};
pub use keys::{
    compute_verifier, unwrap_master_key, verify_master_key, wrap_master_key,
    KeyEncryptionKey, MasterKey, WRAPPED_KEY_LEN,
};
pub use tags::{dedupe_tags, markdown_tags, normalize_tag, same_tag, set_markdown_tags};

/// Derive a 256-bit Key Encryption Key (KEK) using Argon2id with explicit KDF parameters.
///
/// The returned key zeroizes itself when dropped. It is only ever used to
/// wrap and unwrap a [`MasterKey`] — see the [`keys`] module.
///
/// # Errors
///
/// Returns [`MntlError::KdfError`] if `params` are invalid or Argon2 hashing fails.
pub fn derive_kek_with_params(
    password: &str,
    salt: &[u8],
    params: &KdfParams,
) -> Result<KeyEncryptionKey, MntlError> {
    let argon2_params = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(32))
        .map_err(|e| MntlError::KdfError(e.to_string()))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2_params);

    let mut kek = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(password.as_bytes(), salt, kek.as_mut_slice())
        .map_err(|e| MntlError::KdfError(e.to_string()))?;

    Ok(KeyEncryptionKey::from_bytes(*kek))
}

/// Encrypt a note payload using XChaCha20-Poly1305 envelope encryption.
///
/// Generates a random 256-bit content encryption key (CEK) and a 192-bit
/// nonce. The CEK is wrapped using AES-KW with the credential profile's
/// [`MasterKey`]. The raw JSON header bytes are passed into the cipher as
/// Associated Data (AD).
///
/// A fresh CEK and nonce are generated on **every** call, so overwriting an
/// existing note never reuses the previous pair.
///
/// `plaintext` is expected to be a complete `.mntl` document — frontmatter and
/// body, as produced by [`encode_unencrypted_note`] — so that everything about
/// a note except which profile owns it is sealed inside the ciphertext. The
/// same envelope also seals image attachments, with the raw image bytes as
/// the payload.
///
/// Returns the serialized `.mntl.enc` binary envelope.
///
/// # Errors
///
/// Returns [`MntlError::KeyWrapError`] if CEK wrapping fails, and
/// [`MntlError::EncryptionFailed`] if the cipher fails.
pub fn encrypt_note(
    mk: &MasterKey,
    profile_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, MntlError> {
    // 1. Generate random 256-bit CEK and 192-bit Nonce
    let mut cek = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(cek.as_mut_slice());

    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);

    // 2. Wrap CEK using AES-KW (AES-256) under the profile's master key
    let kw = KekAes256::from(*mk.expose());
    let mut wrapped_key = [0u8; keys::WRAPPED_KEY_LEN];
    kw.wrap(cek.as_slice(), &mut wrapped_key)
        .map_err(|_| MntlError::KeyWrapError)?;

    // 3. Assemble JSON Header metadata
    let crypto_meta = CryptoMeta {
        iv: BASE64.encode(nonce_bytes),
        wrapped_key: BASE64.encode(wrapped_key),
    };

    let header = EncryptedHeader::new(profile_id, crypto_meta);
    let header_json = serde_json::to_vec(&header)?;

    // 4. Encrypt payload with XChaCha20-Poly1305 using header_json as Associated Data (AD)
    let cipher = XChaCha20Poly1305::new(Key::from_slice(cek.as_slice()));
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
/// Parses the envelope, unwraps the note's content encryption key using the
/// credential profile's [`MasterKey`], verifies header authenticity via
/// Associated Data (AD), and decrypts the payload.
///
/// `mk` must be the master key of the profile named in the envelope's
/// `credential_profile` field — recover it with [`unwrap_master_key`].
///
/// The returned plaintext is wrapped in [`Zeroizing`], so the buffer is
/// scrubbed when dropped. That is process-local hygiene, not an end-to-end
/// guarantee: once a caller converts it to a `String` and hands it to another
/// process or language runtime, this crate can no longer wipe it.
///
/// # Errors
///
/// Returns [`MntlError::InvalidHeaderSize`] or [`MntlError::InvalidMagicBytes`]
/// if `mntl_enc_bytes` is malformed, [`MntlError::HeaderParseError`] if the
/// header JSON is invalid (including a missing `crypto` section),
/// [`MntlError::UnsupportedVersion`] for an unrecognized envelope version,
/// [`MntlError::InvalidBase64`] or [`MntlError::InvalidCryptoMetadata`] for
/// malformed metadata fields, [`MntlError::KeyWrapError`] if unwrapping the
/// content key fails (i.e. `mk` belongs to a different profile), and
/// [`MntlError::DecryptionFailed`] if the ciphertext or header has been
/// tampered with.
pub fn decrypt_note(
    mk: &MasterKey,
    mntl_enc_bytes: &[u8],
) -> Result<Zeroizing<Vec<u8>>, MntlError> {
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

    if header.v != ENVELOPE_VERSION {
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

    // 5. Unwrap the note's content key using the profile's master key
    let kw = KekAes256::from(*mk.expose());
    let mut cek = Zeroizing::new([0u8; 32]);
    kw.unwrap(&wrapped_key_bytes, cek.as_mut_slice())
        .map_err(|_| MntlError::KeyWrapError)?;

    // 6. Decrypt ciphertext using XChaCha20-Poly1305 with raw header_json_bytes as AD.
    //
    // The AAD is the header slice exactly as it appears on disk, never a
    // re-serialization of `header`. Re-serializing would work right up until
    // serde emitted one byte differently (field order, string escaping) and
    // then silently fail to decrypt every existing note.
    let cipher = XChaCha20Poly1305::new(Key::from_slice(cek.as_slice()));
    let nonce = XNonce::from_slice(&nonce_bytes);
    let payload = Payload {
        msg: ciphertext,
        aad: header_json_bytes,
    };

    let plaintext = cipher
        .decrypt(nonce, payload)
        .map_err(|_| MntlError::DecryptionFailed)?;

    Ok(Zeroizing::new(plaintext))
}

/// The `---\n` delimiter line that opens and closes a `.mntl` frontmatter block.
const FRONTMATTER_DELIM: &str = "---";

/// Split a `.mntl` file into its raw frontmatter YAML and body text.
///
/// Expects the file to start with a line containing exactly `---`, followed
/// by the frontmatter, followed by another line containing exactly `---`.
/// Everything after that closing delimiter's newline is the body.
pub(crate) fn split_frontmatter(note: &str) -> Result<(&str, &str), MntlError> {
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
    encode_note(&NoteFrontmatter::default(), content)
}

/// Encode a note into a `.mntl` text file under the given frontmatter, e.g.
/// to keep a note's tags across a save.
///
/// `frontmatter.v` is written as given; pass [`NoteFrontmatter::default`]
/// (with fields set on it) to write the current [`NOTE_VERSION`].
///
/// # Errors
///
/// Returns [`MntlError::FrontmatterParseError`] if the frontmatter header
/// fails to serialize (not expected to happen in practice).
pub fn encode_note(frontmatter: &NoteFrontmatter, content: &str) -> Result<String, MntlError> {
    let yaml = serde_yaml::to_string(frontmatter)?;
    let yaml = yaml.trim_end_matches('\n');

    Ok(format!("{FRONTMATTER_DELIM}\n{yaml}\n{FRONTMATTER_DELIM}\n{content}"))
}

/// Decode a `.mntl` text file into its note body, discarding the frontmatter.
///
/// # Errors
///
/// As [`decode_note`].
pub fn decode_unencrypted_note(note: &str) -> Result<String, MntlError> {
    decode_note(note).map(|(_, body)| body)
}

/// Decode a `.mntl` text file into its frontmatter and note body.
///
/// # Errors
///
/// Returns [`MntlError::MissingFrontmatter`] if `note` does not start with a
/// well-formed `---` frontmatter block, [`MntlError::FrontmatterParseError`]
/// if the frontmatter YAML is invalid, and [`MntlError::UnsupportedVersion`]
/// if its `v` field does not match [`NOTE_VERSION`].
pub fn decode_note(note: &str) -> Result<(NoteFrontmatter, String), MntlError> {
    let (frontmatter, body) = split_frontmatter(note)?;
    let header: NoteFrontmatter = serde_yaml::from_str(frontmatter)?;

    if header.v != NOTE_VERSION {
        return Err(MntlError::UnsupportedVersion(header.v));
    }

    Ok((header, body.to_string()))
}

/// Split a plain Markdown (`.md`) file into its YAML frontmatter block and
/// body, returning the block **verbatim** — delimiters, line endings and all —
/// so it can be written back byte-for-byte in front of an edited body.
///
/// Unlike [`decode_unencrypted_note`], nothing here is parsed or validated:
/// the frontmatter belongs to whatever other tool wrote the file, not to this
/// crate. A file without a well-formed `---` block has an empty prefix and is
/// all body.
pub fn split_markdown_frontmatter(markdown: &str) -> (&str, &str) {
    match split_frontmatter(markdown) {
        Ok((_, body)) => markdown.split_at(markdown.len() - body.len()),
        Err(_) => ("", markdown),
    }
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
