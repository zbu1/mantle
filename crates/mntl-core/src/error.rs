//! Error type returned by this crate's fallible operations.

use thiserror::Error;

/// Errors that can occur while encoding, decoding, encrypting, or decrypting
/// `.mntl` / `.mntl.enc` notes.
#[derive(Error, Debug)]
pub enum MntlError {
    /// A `.mntl.enc` envelope's leading 4 bytes were not [`crate::MAGIC_MENC`].
    #[error("Invalid magic bytes: expected 'MENC'")]
    InvalidMagicBytes,

    /// The `.mntl.enc` envelope is truncated: it is shorter than the fixed
    /// header prefix, shorter than the declared header length, or the
    /// declared header length does not fit in a `u32`.
    #[error("Invalid header size: header exceeds available payload bounds")]
    InvalidHeaderSize,

    /// The `.mntl.enc` header bytes could not be parsed as JSON, or a header
    /// failed to serialize.
    #[error("Header parse error: {0}")]
    HeaderParseError(#[from] serde_json::Error),

    /// A `.mntl` file did not start with a `---` YAML frontmatter delimiter
    /// line, or had no closing `---` line.
    #[error("Missing or malformed YAML frontmatter block")]
    MissingFrontmatter,

    /// The `.mntl` frontmatter block could not be parsed as YAML, or a
    /// frontmatter header failed to serialize.
    #[error("Frontmatter parse error: {0}")]
    FrontmatterParseError(#[from] serde_yaml::Error),

    /// Argon2id key derivation failed, typically due to invalid [`crate::KdfParams`].
    #[error("KDF error: {0}")]
    KdfError(String),

    /// AES-KW wrapping or unwrapping of the Data Encryption Key failed, or
    /// the supplied Key Encryption Key was not exactly 32 bytes.
    #[error("Key wrap error: failed to wrap or unwrap DEK")]
    KeyWrapError,

    /// XChaCha20-Poly1305 decryption failed: either the ciphertext or the
    /// associated header data was invalid or tampered with.
    #[error("Decryption failed: invalid ciphertext or tampered header (AD mismatch)")]
    DecryptionFailed,

    /// XChaCha20-Poly1305 encryption of the payload failed.
    #[error("Encryption failed: payload encryption error")]
    EncryptionFailed,

    /// A field within [`crate::CryptoMeta`] had an unexpected value (e.g. wrong nonce length).
    #[error("Invalid crypto metadata: {0}")]
    InvalidCryptoMetadata(String),

    /// The header's `v` field did not match [`crate::NOTE_VERSION`] (for a
    /// `.mntl` note) or [`crate::ENVELOPE_VERSION`] (for a `.mntl.enc` envelope).
    #[error("Unsupported format version: {0}")]
    UnsupportedVersion(u8),

    /// A field expected to contain Base64 could not be decoded.
    #[error("Invalid Base64 string encoding")]
    InvalidBase64,

    /// Secure random byte generation failed.
    #[error("Randomness generation error: {0}")]
    RngError(String),
}
