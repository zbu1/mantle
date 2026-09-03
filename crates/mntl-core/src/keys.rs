//! The key hierarchy behind credential profiles.
//!
//! Three distinct 256-bit keys are in play, and they are deliberately given
//! distinct types so the compiler can tell them apart:
//!
//! ```text
//! password ──Argon2id(profile salt)──► KeyEncryptionKey (KEK)
//!                                            │ AES-KW
//!                                            ▼
//!                                       MasterKey (MK)        one per profile
//!                                            │ AES-KW
//!                                            ▼
//!                          content key (CEK) ──► XChaCha20-Poly1305(note)
//! ```
//!
//! The KEK is never stored. The MK is stored wrapped by the KEK, once per
//! profile, outside this crate (Mantle keeps it in `.mantle/profiles.json`).
//! Each note stores its own CEK wrapped by the MK, in its envelope header.
//!
//! The indirection is what makes a password change cheap: re-derive the KEK
//! from the new password and rewrap the same MK. Every note's wrapped CEK
//! stays valid, so no note is rewritten.
//!
//! Neither key type implements `Serialize`, `Display`, or a derived `Debug` —
//! their `Debug` impls are written by hand to print a redacted placeholder,
//! because Mantle writes command errors verbatim to an on-disk log and a
//! stray `{:?}` must be structurally incapable of leaking key material.

use aes_kw::KekAes256;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::MntlError;

/// Length in bytes of an AES-KW-wrapped 256-bit key (32 bytes + an 8-byte
/// integrity check value).
pub const WRAPPED_KEY_LEN: usize = 40;

/// Domain-separation string for [`compute_verifier`]. Changing this
/// invalidates every stored verifier, so it is versioned.
const VERIFIER_DOMAIN: &[u8] = b"mantle/profile-verifier/v1";

/// A 256-bit key derived from a password with Argon2id, used only to wrap and
/// unwrap a [`MasterKey`]. Never stored; re-derived on every unlock.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct KeyEncryptionKey([u8; 32]);

/// A 256-bit per-profile master key. Wraps every note's content key, and is
/// itself stored wrapped by a [`KeyEncryptionKey`].
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct MasterKey([u8; 32]);

impl KeyEncryptionKey {
    /// Build a KEK from raw bytes. Callers normally use [`crate::derive_kek`].
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Borrow the raw key bytes.
    ///
    /// Named `expose` rather than `as_bytes` so every site that handles raw
    /// key material is greppable.
    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl MasterKey {
    /// Generate a fresh master key from the OS CSPRNG.
    pub fn generate() -> Result<Self, MntlError> {
        let mut bytes = [0u8; 32];
        OsRng
            .try_fill_bytes(&mut bytes)
            .map_err(|e| MntlError::RngError(e.to_string()))?;
        Ok(Self(bytes))
    }

    /// Build a master key from raw bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Borrow the raw key bytes. See [`KeyEncryptionKey::expose`].
    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

// Hand-written so key bytes can never reach a log through `{:?}`.
impl std::fmt::Debug for KeyEncryptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KeyEncryptionKey(<redacted>)")
    }
}

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(<redacted>)")
    }
}

/// Generate a fresh [`MasterKey`]. Convenience wrapper over [`MasterKey::generate`].
///
/// # Errors
///
/// Returns [`MntlError::RngError`] if the OS random number generator fails.
pub fn generate_master_key() -> Result<MasterKey, MntlError> {
    MasterKey::generate()
}

/// Wrap a master key with a KEK using AES-KW (AES-256).
///
/// # Errors
///
/// Returns [`MntlError::KeyWrapError`] if wrapping fails.
pub fn wrap_master_key(
    kek: &KeyEncryptionKey,
    mk: &MasterKey,
) -> Result<[u8; WRAPPED_KEY_LEN], MntlError> {
    let kw = KekAes256::from(*kek.expose());
    let mut wrapped = [0u8; WRAPPED_KEY_LEN];
    kw.wrap(mk.expose(), &mut wrapped)
        .map_err(|_| MntlError::KeyWrapError)?;
    Ok(wrapped)
}

/// Unwrap a master key with a KEK using AES-KW (AES-256).
///
/// AES-KW carries a 64-bit integrity check value, so **this is also the
/// password check**: a KEK derived from the wrong password fails here rather
/// than producing a garbage key. Callers should surface
/// [`MntlError::KeyWrapError`] to users as "incorrect password".
///
/// # Errors
///
/// Returns [`MntlError::KeyWrapError`] if `wrapped` is not
/// [`WRAPPED_KEY_LEN`] bytes or its integrity check fails.
pub fn unwrap_master_key(kek: &KeyEncryptionKey, wrapped: &[u8]) -> Result<MasterKey, MntlError> {
    if wrapped.len() != WRAPPED_KEY_LEN {
        return Err(MntlError::KeyWrapError);
    }

    let kw = KekAes256::from(*kek.expose());
    let mut mk = [0u8; 32];
    kw.unwrap(wrapped, &mut mk)
        .map_err(|_| MntlError::KeyWrapError)?;
    Ok(MasterKey::from_bytes(mk))
}

/// Compute a verifier tag for a master key, as Base64.
///
/// AES-KW already rejects a wrong password in [`unwrap_master_key`], so this
/// is not what proves a password correct. Its job is to tell a *wrong
/// password* apart from a *corrupt or hand-edited profile record*: if the
/// unwrap succeeds but the verifier does not match, the stored wrapped key is
/// not the one this profile was created with.
///
/// Derived from the master key rather than the password, so it survives a
/// password change untouched.
pub fn compute_verifier(mk: &MasterKey) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(mk.expose())
        .expect("HMAC accepts keys of any length");
    mac.update(VERIFIER_DOMAIN);
    BASE64.encode(mac.finalize().into_bytes())
}

/// Check a master key against a verifier produced by [`compute_verifier`],
/// in constant time. A malformed or non-Base64 `verifier` returns `false`.
pub fn verify_master_key(mk: &MasterKey, verifier: &str) -> bool {
    let Ok(expected) = BASE64.decode(verifier) else {
        return false;
    };
    let actual = BASE64
        .decode(compute_verifier(mk))
        .expect("compute_verifier emits valid Base64");

    actual.ct_eq(&expected).into()
}
