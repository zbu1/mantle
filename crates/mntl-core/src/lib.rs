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
pub use header::{CryptoMeta, KdfParams, MntlHeader, CURRENT_VERSION, HEADER_OFFSET, MAGIC_MENC, MAGIC_MNTL};

/// Derive a 256-bit Key Encryption Key (KEK) using Argon2id with default KDF parameters.
pub fn derive_kek(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, MntlError> {
    derive_kek_with_params(password, salt, &KdfParams::default())
}

/// Derive a 256-bit Key Encryption Key (KEK) using Argon2id with explicit KDF parameters.
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
pub fn encrypt_note(
    kek: &[u8],
    salt: &[u8],
    profile_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, MntlError> {
    encrypt_note_with_params(kek, salt, profile_id, plaintext, &KdfParams::default())
}

/// Encrypt a note payload with explicit KDF parameters recorded in header metadata.
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

    let header = MntlHeader::new_encrypted(profile_id, crypto_meta);
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
    let header: MntlHeader = serde_json::from_slice(header_json_bytes)?;

    if header.v != CURRENT_VERSION {
        return Err(MntlError::UnsupportedVersion(header.v));
    }

    let crypto = header.crypto.ok_or(MntlError::MissingCryptoMetadata)?;

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

/// Encode an unencrypted `.mntl` note into a binary envelope.
pub fn encode_unencrypted_note(profile_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, MntlError> {
    let header = MntlHeader::new_unencrypted(profile_id);
    let header_json = serde_json::to_vec(&header)?;
    let header_len = u32::try_from(header_json.len()).map_err(|_| MntlError::InvalidHeaderSize)?;

    let mut output = Vec::with_capacity(HEADER_OFFSET + header_json.len() + plaintext.len());
    output.extend_from_slice(MAGIC_MNTL);
    output.extend_from_slice(&header_len.to_le_bytes());
    output.extend_from_slice(&header_json);
    output.extend_from_slice(plaintext);

    Ok(output)
}

/// Decode an unencrypted `.mntl` binary envelope into raw plaintext payload.
pub fn decode_unencrypted_note(mntl_bytes: &[u8]) -> Result<Vec<u8>, MntlError> {
    if mntl_bytes.len() < HEADER_OFFSET {
        return Err(MntlError::InvalidHeaderSize);
    }

    if &mntl_bytes[0..4] != MAGIC_MNTL {
        return Err(MntlError::InvalidMagicBytes);
    }

    let header_len = u32::from_le_bytes(
        mntl_bytes[4..8]
            .try_into()
            .map_err(|_| MntlError::InvalidHeaderSize)?,
    ) as usize;

    let header_end = HEADER_OFFSET + header_len;
    if mntl_bytes.len() < header_end {
        return Err(MntlError::InvalidHeaderSize);
    }

    Ok(mntl_bytes[header_end..].to_vec())
}

/// Fast header extraction without decrypting or processing payload.
///
/// Works for both `.mntl` and `.mntl.enc` envelope binaries.
pub fn extract_header_only(mntl_bytes: &[u8]) -> Result<MntlHeader, MntlError> {
    if mntl_bytes.len() < HEADER_OFFSET {
        return Err(MntlError::InvalidHeaderSize);
    }

    let magic = &mntl_bytes[0..4];
    if magic != MAGIC_MNTL && magic != MAGIC_MENC {
        return Err(MntlError::InvalidMagicBytes);
    }

    let header_len = u32::from_le_bytes(
        mntl_bytes[4..8]
            .try_into()
            .map_err(|_| MntlError::InvalidHeaderSize)?,
    ) as usize;

    let header_end = HEADER_OFFSET + header_len;
    if mntl_bytes.len() < header_end {
        return Err(MntlError::InvalidHeaderSize);
    }

    let header_json_bytes = &mntl_bytes[HEADER_OFFSET..header_end];
    let header: MntlHeader = serde_json::from_slice(header_json_bytes)?;

    Ok(header)
}
