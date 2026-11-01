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

/// The `.mntl` plaintext note format version written by this crate.
///
/// Stored in [`NoteFrontmatter::v`]; [`crate::decode_unencrypted_note`]
/// rejects any other value via [`crate::MntlError::UnsupportedVersion`].
///
/// Deliberately separate from [`ENVELOPE_VERSION`]: the two formats evolve
/// independently, and sharing one constant meant a change to either format
/// silently invalidated every file of the other.
pub const NOTE_VERSION: u8 = 2;

/// The `.mntl.enc` encrypted envelope format version written by this crate.
///
/// Stored in [`EncryptedHeader::v`]; [`crate::decrypt_note`] rejects any other
/// value via [`crate::MntlError::UnsupportedVersion`]. See [`NOTE_VERSION`].
///
/// Version 3 introduced the per-profile master key: [`CryptoMeta::wrapped_key`]
/// is now the note's content key wrapped by the profile's master key, where in
/// version 2 it was wrapped directly by the password-derived KEK. The field is
/// the same name and the same length, so a version 2 reader handed a version 3
/// file would produce garbage rather than an error — hence the bump.
pub const ENVELOPE_VERSION: u8 = 3;

/// Argon2id cost parameters used to derive a Key Encryption Key from a password.
///
/// Stored once per credential profile, alongside that profile's salt, by
/// whoever owns the profile registry — **not** in note headers. See
/// [`CryptoMeta`] for why.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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
///
/// Note what is deliberately *absent*: the Argon2id salt and cost parameters.
/// Those describe the credential profile, not the note, and live in the
/// profile registry. Copying them into every note header would mean N drifting
/// duplicates of one value — after a KDF-cost upgrade every header would hold
/// numbers that are either ignored or actively wrong.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CryptoMeta {
    /// Base64-encoded 192-bit XChaCha20-Poly1305 nonce.
    pub iv: String,
    /// Base64-encoded content encryption key for this note, AES-KW-wrapped
    /// with the credential profile's master key.
    pub wrapped_key: String,
}

/// The JSON header stored in every `.mntl.enc` binary envelope.
///
/// Serialized bytes of this struct are passed to the payload cipher as
/// associated data, so any tampering with the header causes decryption to
/// fail. See the [crate-level docs](crate) for the full envelope layout.
///
/// # Why this struct stays minimal
///
/// Because the header *is* the AAD, a field can never be added to an existing
/// note's header without re-encrypting its body. So the header carries only
/// what is needed to *find the key* — which profile, which wrapped content
/// key, which nonce — and nothing that changes over a note's lifetime.
///
/// Everything else about a note (its title, tags, timestamps) belongs in the
/// [`NoteFrontmatter`] of the plaintext document, which is sealed *inside* the
/// ciphertext. That is what keeps the note format free to evolve: adding a
/// field there is invisible to the envelope and costs no re-encryption.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedHeader {
    /// Envelope format version; must equal [`ENVELOPE_VERSION`] to decrypt.
    pub v: u8,
    /// Identifier of the credential profile the note is encrypted under.
    pub credential_profile: String,
    /// Encryption metadata for the note.
    pub crypto: CryptoMeta,
    /// Whether the note's real location and name are sealed in its
    /// [`NoteFrontmatter`] rather than given by where the file sits, so a
    /// locked vault can leave it out of the tree. Omitted when false, which
    /// keeps every other header byte for byte what it was before this field
    /// existed, so no [`ENVELOPE_VERSION`] bump; and being AAD, it can't be
    /// forged or stripped.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Plaintext bytes per chunk of a chunked envelope ([`crate::stream`],
    /// version [`crate::STREAM_VERSION`]); absent from every other header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk: Option<u32>,
}

impl EncryptedHeader {
    /// Build a header for an encrypted note with the given profile and crypto metadata.
    pub fn new(profile_id: impl Into<String>, crypto: CryptoMeta) -> Self {
        Self {
            v: ENVELOPE_VERSION,
            credential_profile: profile_id.into(),
            crypto,
            hidden: false,
            chunk: None,
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
/// tags:
/// - reference
/// ---
/// # My note
///
/// Body content in Markdown.
/// ```
///
/// Unlike [`EncryptedHeader`], there is no `credential_profile` here: a
/// plaintext note isn't encrypted under any credential.
///
/// Adding an optional field here needs no [`NOTE_VERSION`] bump: a reader that
/// doesn't know the field ignores it (serde skips unknown keys), and a note
/// without it decodes to the field's default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteFrontmatter {
    /// Note format version; must equal [`NOTE_VERSION`] to decode.
    pub v: u8,
    /// The note's tags, in the order the user added them. Omitted from the
    /// file when empty. See [`crate::tags`] for what a valid tag is.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Whether the note is a favorite. Only encrypted notes use this, so
    /// which of them are favorites stays sealed; a plaintext note's favorite
    /// lives in the vault's `.mantle/state.json` instead. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
    /// The note's sidebar icon (a Lucide icon name) and color (a palette
    /// name). Only encrypted notes use these, so they stay sealed; a plaintext
    /// note's live in `.mantle/state.json`. Omitted when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The user's own properties (`due`, `status`, ...), in display order.
    /// Nested under one key so a property can't collide with the fields
    /// above. Omitted when empty. See [`crate::properties`].
    #[serde(default, skip_serializing_if = "serde_yaml::Mapping::is_empty")]
    pub properties: serde_yaml::Mapping,
    /// A hidden note's real folder, vault-relative (empty for the root), for
    /// a note whose file sits elsewhere. Set together with `name`, and only on
    /// an encrypted note whose header says it's hidden.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// A hidden note's real name (file stem), for a note whose file has
    /// another name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Default for NoteFrontmatter {
    fn default() -> Self {
        Self {
            v: NOTE_VERSION,
            tags: Vec::new(),
            favorite: false,
            icon: None,
            color: None,
            properties: serde_yaml::Mapping::new(),
            location: None,
            name: None,
        }
    }
}
