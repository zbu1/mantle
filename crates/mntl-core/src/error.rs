use thiserror::Error;

#[derive(Error, Debug)]
pub enum MntlError {
    #[error("Invalid magic bytes: expected 'MNTL' or 'MENC'")]
    InvalidMagicBytes,

    #[error("Invalid header size: header exceeds available payload bounds")]
    InvalidHeaderSize,

    #[error("Header parse error: {0}")]
    HeaderParseError(#[from] serde_json::Error),

    #[error("KDF error: {0}")]
    KdfError(String),

    #[error("Key wrap error: failed to wrap or unwrap DEK")]
    KeyWrapError,

    #[error("Decryption failed: invalid ciphertext or tampered header (AD mismatch)")]
    DecryptionFailed,

    #[error("Encryption failed: payload encryption error")]
    EncryptionFailed,

    #[error("Missing crypto metadata in encrypted file header")]
    MissingCryptoMetadata,

    #[error("Invalid crypto metadata: {0}")]
    InvalidCryptoMetadata(String),


    #[error("Unsupported envelope version: {0}")]
    UnsupportedVersion(u8),

    #[error("Invalid Base64 string encoding")]
    InvalidBase64,

    #[error("Randomness generation error: {0}")]
    RngError(String),
}
