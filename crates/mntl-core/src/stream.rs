//! The chunked envelope, for large sealed attachments (videos, PDFs) that are
//! read a range at a time rather than whole.
//!
//! It is the `.mntl.enc` envelope ([`crate::encrypt_note`]) with the payload
//! cut into chunks, each sealed on its own, in the STREAM construction
//! (Hoang, Reyhanitabar, Rogaway, Vizár, "Online Authenticated-Encryption and
//! its Nonce-Reuse Misuse-Resistance"): chunk `i`'s nonce is the header's
//! 19-byte prefix, then `i` as a big-endian `u32`, then a byte that is 1 for
//! the last chunk and 0 otherwise. Reordering chunks or cutting the file short
//! at a chunk boundary therefore fails to decrypt, as tampering with any byte
//! does. Every chunk takes the header bytes as associated data, as a note does.
//!
//! ```text
//! | magic | header_len | header (v: 4, chunk: N) | chunk 0 | chunk 1 | … | last chunk |
//!                                                 \ ≤ N plaintext bytes + 16-byte tag /
//! ```
//!
//! Every chunk but the last holds exactly `chunk` plaintext bytes, so where
//! any byte of the plaintext lies follows from the file's length alone.

use crate::header::{CryptoMeta, EncryptedHeader, HEADER_OFFSET, MAGIC_MENC};
use crate::keys::{MasterKey, WRAPPED_KEY_LEN};
use crate::MntlError;
use aes_kw::KekAes256;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

/// Envelope version of a chunked envelope.
pub const STREAM_VERSION: u8 = 4;

/// Plaintext bytes per chunk that Mantle writes.
pub const STREAM_CHUNK: u32 = 64 * 1024;

const TAG_LEN: u64 = 16;
const PREFIX_LEN: usize = 19;

fn nonce(prefix: &[u8; PREFIX_LEN], index: u64, last: bool) -> Result<XNonce, MntlError> {
    let index = u32::try_from(index).map_err(|_| MntlError::InvalidHeaderSize)?;
    let mut nonce = [0u8; 24];
    nonce[..PREFIX_LEN].copy_from_slice(prefix);
    nonce[PREFIX_LEN..23].copy_from_slice(&index.to_be_bytes());
    nonce[23] = last as u8;
    Ok(*XNonce::from_slice(&nonce))
}

/// Seal `plaintext` under the profile's master key in the chunked envelope,
/// `chunk_size` bytes to a chunk ([`STREAM_CHUNK`], outside of tests).
///
/// # Errors
///
/// Returns [`MntlError::KeyWrapError`] if wrapping the content key fails, and
/// [`MntlError::EncryptionFailed`] if the cipher does.
pub fn encrypt_stream(mk: &MasterKey, profile_id: &str, plaintext: &[u8], chunk_size: u32) -> Result<Vec<u8>, MntlError> {
    if chunk_size == 0 {
        return Err(MntlError::InvalidCryptoMetadata("Chunk size must not be zero".into()));
    }
    let mut cek = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(cek.as_mut_slice());
    let mut prefix = [0u8; PREFIX_LEN];
    OsRng.fill_bytes(&mut prefix);

    let mut wrapped_key = [0u8; WRAPPED_KEY_LEN];
    KekAes256::from(*mk.expose())
        .wrap(cek.as_slice(), &mut wrapped_key)
        .map_err(|_| MntlError::KeyWrapError)?;
    let crypto = CryptoMeta { iv: BASE64.encode(prefix), wrapped_key: BASE64.encode(wrapped_key) };
    let header = EncryptedHeader { v: STREAM_VERSION, chunk: Some(chunk_size), ..EncryptedHeader::new(profile_id, crypto) };
    let header_json = serde_json::to_vec(&header)?;
    let header_len = u32::try_from(header_json.len()).map_err(|_| MntlError::InvalidHeaderSize)?;

    let cipher = XChaCha20Poly1305::new(Key::from_slice(cek.as_slice()));
    let chunks: Vec<&[u8]> = if plaintext.is_empty() { vec![&[]] } else { plaintext.chunks(chunk_size as usize).collect() };
    let mut out = Vec::with_capacity(HEADER_OFFSET + header_json.len() + plaintext.len() + chunks.len() * TAG_LEN as usize);
    out.extend_from_slice(MAGIC_MENC);
    out.extend_from_slice(&header_len.to_le_bytes());
    out.extend_from_slice(&header_json);
    for (i, chunk) in chunks.iter().enumerate() {
        let nonce = nonce(&prefix, i as u64, i + 1 == chunks.len())?;
        let sealed = cipher
            .encrypt(&nonce, Payload { msg: chunk, aad: &header_json })
            .map_err(|_| MntlError::EncryptionFailed)?;
        out.extend_from_slice(&sealed);
    }
    Ok(out)
}

/// Where a run of chunks lies, from [`SealedStream::chunks_for`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkSpan {
    /// The first chunk's index, for [`SealedStream::decrypt_chunks`].
    pub first: u64,
    /// Where in the file the chunks start, and how many bytes they take.
    pub file_offset: u64,
    pub file_len: u64,
    /// Where in the plaintext the first chunk starts.
    pub plaintext_offset: u64,
}

/// An opened chunked envelope: its key and layout, for decrypting any range
/// of it without reading the rest.
pub struct SealedStream {
    cipher: XChaCha20Poly1305,
    prefix: [u8; PREFIX_LEN],
    aad: Vec<u8>,
    data_offset: u64,
    chunk: u64,
    chunks: u64,
    len: u64,
}

impl SealedStream {
    /// Open the envelope whose first bytes are `head` (at least its whole
    /// header) and whose whole file is `file_len` bytes long.
    ///
    /// # Errors
    ///
    /// As [`crate::decrypt_note`], plus [`MntlError::UnsupportedVersion`] for
    /// an envelope that isn't chunked.
    pub fn open(mk: &MasterKey, head: &[u8], file_len: u64) -> Result<Self, MntlError> {
        if head.len() < HEADER_OFFSET || &head[..4] != MAGIC_MENC {
            return Err(MntlError::InvalidMagicBytes);
        }
        let header_len = u32::from_le_bytes(head[4..8].try_into().map_err(|_| MntlError::InvalidHeaderSize)?) as usize;
        let header_end = HEADER_OFFSET.checked_add(header_len).ok_or(MntlError::InvalidHeaderSize)?;
        let aad = head.get(HEADER_OFFSET..header_end).ok_or(MntlError::InvalidHeaderSize)?.to_vec();
        let header: EncryptedHeader = serde_json::from_slice(&aad)?;
        let chunk = match (header.v, header.chunk) {
            (STREAM_VERSION, Some(chunk)) if chunk > 0 => u64::from(chunk),
            _ => return Err(MntlError::UnsupportedVersion(header.v)),
        };
        let prefix: [u8; PREFIX_LEN] = BASE64
            .decode(&header.crypto.iv)
            .map_err(|_| MntlError::InvalidBase64)?
            .try_into()
            .map_err(|_| MntlError::InvalidCryptoMetadata("Invalid nonce prefix length".into()))?;
        let wrapped_key = BASE64.decode(&header.crypto.wrapped_key).map_err(|_| MntlError::InvalidBase64)?;
        let mut cek = Zeroizing::new([0u8; 32]);
        KekAes256::from(*mk.expose())
            .unwrap(&wrapped_key, cek.as_mut_slice())
            .map_err(|_| MntlError::KeyWrapError)?;

        let sealed_len = file_len.checked_sub(header_end as u64).ok_or(MntlError::InvalidHeaderSize)?;
        let chunks = sealed_len.div_ceil(chunk + TAG_LEN);
        let last = sealed_len.checked_sub(chunks.saturating_sub(1) * (chunk + TAG_LEN)).unwrap_or(0);
        if chunks == 0 || last < TAG_LEN {
            return Err(MntlError::InvalidHeaderSize);
        }
        Ok(Self {
            cipher: XChaCha20Poly1305::new(Key::from_slice(cek.as_slice())),
            prefix,
            aad,
            data_offset: header_end as u64,
            chunk,
            chunks,
            len: sealed_len - chunks * TAG_LEN,
        })
    }

    /// The plaintext's length.
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The chunks holding plaintext bytes `start..end` (`end` clamped to the
    /// plaintext's length).
    pub fn chunks_for(&self, start: u64, end: u64) -> ChunkSpan {
        let end = end.min(self.len).max(start.saturating_add(1));
        let first = (start / self.chunk).min(self.chunks - 1);
        let last = ((end - 1) / self.chunk).min(self.chunks - 1);
        let offset = self.data_offset + first * (self.chunk + TAG_LEN);
        let file_end = (self.data_offset + (last + 1) * (self.chunk + TAG_LEN)).min(self.data_offset + self.len + self.chunks * TAG_LEN);
        ChunkSpan { first, file_offset: offset, file_len: file_end - offset, plaintext_offset: first * self.chunk }
    }

    /// Decrypt `sealed`, consecutive chunks starting at chunk `first`, as
    /// [`Self::chunks_for`] located them.
    ///
    /// # Errors
    ///
    /// [`MntlError::DecryptionFailed`] if any chunk was tampered with, moved
    /// or cut short.
    pub fn decrypt_chunks(&self, first: u64, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, MntlError> {
        let mut out = Zeroizing::new(Vec::with_capacity(sealed.len()));
        for (i, chunk) in sealed.chunks((self.chunk + TAG_LEN) as usize).enumerate() {
            let index = first + i as u64;
            let last = index + 1 == self.chunks;
            if index >= self.chunks || (!last && chunk.len() as u64 != self.chunk + TAG_LEN) {
                return Err(MntlError::DecryptionFailed);
            }
            let plain = Zeroizing::new(
                self.cipher
                    .decrypt(&nonce(&self.prefix, index, last)?, Payload { msg: chunk, aad: &self.aad })
                    .map_err(|_| MntlError::DecryptionFailed)?,
            );
            out.extend_from_slice(&plain);
        }
        Ok(out)
    }
}

/// Decrypt a whole chunked envelope.
///
/// # Errors
///
/// As [`SealedStream::open`] and [`SealedStream::decrypt_chunks`].
pub fn decrypt_stream(mk: &MasterKey, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, MntlError> {
    let stream = SealedStream::open(mk, blob, blob.len() as u64)?;
    let data = usize::try_from(stream.data_offset).map_err(|_| MntlError::InvalidHeaderSize)?;
    let plain = stream.decrypt_chunks(0, &blob[data..])?;
    if plain.len() as u64 != stream.len {
        return Err(MntlError::DecryptionFailed);
    }
    Ok(plain)
}
