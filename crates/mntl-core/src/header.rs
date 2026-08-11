//! Header types for the two note formats this crate handles:
//! the binary `.mntl.enc` envelope ([`EncryptedHeader`]) and the plain-text
//! `.mntl` Markdown-with-frontmatter format ([`NoteFrontmatter`]).

use serde::{Deserialize, Serialize};

/// Magic bytes identifying an encrypted `.mntl.enc` envelope.
pub const MAGIC_MENC: &[u8; 4] = b"MENC";

/// Byte offset of the JSON header within a `.mntl.enc` envelope, i.e. the
/// size of the magic bytes (4) plus the little-endian `u32` header length
/// prefix (4).
pub const HEADER_OFFSET: usize = 8;

/// The format version written by this crate, for both `.mntl.enc` envelopes
/// and `.mntl` frontmatter.
///
/// Stored in [`EncryptedHeader::v`] and [`NoteFrontmatter::v`]; decoding
/// rejects any other value via [`crate::MntlError::UnsupportedVersion`].
pub const CURRENT_VERSION: u8 = 2;

/// Argon2id cost parameters used to derive a Key Encryption Key from a password.
///
/// Recorded alongside the salt in [`CryptoMeta`] so the same KEK can be
/// re-derived later even if the default parameters change in a future
/// version of this crate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost: u32,
    /// Number of iterations.
    pub t_cost: u32,
    /// Degree of parallelism (lanes).
    pub p_cost: u32,
}

impl Default for KdfParams {
    /// Argon2id parameters of 19456 KiB memory, 3 iterations, 1 lane.
    fn default() -> Self {
        Self {
            m_cost: 19456,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

/// Cryptographic metadata for an encrypted note, embedded in [`EncryptedHeader::crypto`].
///
/// All binary fields are stored as standard Base64 strings so the header
/// serializes as plain JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CryptoMeta {
    /// Base64-encoded 192-bit XChaCha20-Poly1305 nonce.
    pub iv: String,
    /// Base64-encoded salt used to derive the Key Encryption Key.
    pub salt: String,
    /// Base64-encoded Data Encryption Key, AES-KW-wrapped with the Key Encryption Key.
    pub wrapped_key: String,
    /// Argon2id parameters used to derive the Key Encryption Key from the password and `salt`.
    pub kdf: KdfParams,
}

/// The JSON header stored in every `.mntl.enc` binary envelope.
///
/// Serialized bytes of this struct are passed to the payload cipher as
/// associated data, so any tampering with the header causes decryption to
/// fail. See the [crate-level docs](crate) for the full envelope layout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedHeader {
    /// Envelope format version; must equal [`CURRENT_VERSION`] to decrypt.
    pub v: u8,
    /// Identifier of the credential profile the note is encrypted under.
    pub credential_profile: String,
    /// Encryption metadata for the note.
    pub crypto: CryptoMeta,
}

impl EncryptedHeader {
    /// Build a header for an encrypted note with the given profile and crypto metadata.
    pub fn new(profile_id: impl Into<String>, crypto: CryptoMeta) -> Self {
        Self {
            v: CURRENT_VERSION,
            credential_profile: profile_id.into(),
            crypto,
        }
    }
}

/// The YAML frontmatter header of a plain `.mntl` note.
///
/// A `.mntl` file is a plain UTF-8 Markdown document with this header
/// rendered as a YAML frontmatter block at the top, e.g.:
///
/// ```text
/// ---
/// v: 2
/// ---
/// # My note
///
/// Body content in Markdown.
/// ```
///
/// Unlike [`EncryptedHeader`], there is no `credential_profile` here: a
/// plaintext note isn't encrypted under any credential.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteFrontmatter {
    /// Note format version; must equal [`CURRENT_VERSION`] to decode.
    pub v: u8,
}

impl Default for NoteFrontmatter {
    fn default() -> Self {
        Self { v: CURRENT_VERSION }
    }
}
