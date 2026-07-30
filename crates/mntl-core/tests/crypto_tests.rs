use mntl_core::{
    decode_unencrypted_note, decrypt_note, derive_kek, derive_kek_with_params,
    encode_unencrypted_note, encrypt_note, encrypt_note_with_params, extract_header_only,
    KdfParams, MntlError, CURRENT_VERSION, MAGIC_MENC, MAGIC_MNTL,
};

#[test]
fn test_derive_kek_deterministic() {
    let password = "SuperSecretPassword123!";
    let salt = b"unique_salt_1234";

    let kek1 = derive_kek(password, salt).unwrap();
    let kek2 = derive_kek(password, salt).unwrap();

    assert_eq!(*kek1, *kek2);
    assert_eq!(kek1.len(), 32);

    let kek_different = derive_kek("DifferentPassword", salt).unwrap();
    assert_ne!(*kek1, *kek_different);
}

#[test]
fn test_encrypt_decrypt_roundtrip() {
    let password = "MySecurePassword";
    let salt = b"random_salt_bytes";
    let profile_id = "550e8400-e29b-41d4-a716-446655440000";
    let plaintext = b"Hello, zero-knowledge world! This is confidential note data.";

    let kek = derive_kek(password, salt).unwrap();
    let encrypted_blob = encrypt_note(&kek[..], salt, profile_id, plaintext).unwrap();

    // Verify binary magic header
    assert_eq!(&encrypted_blob[0..4], MAGIC_MENC);

    // Decrypt using same KEK
    let decrypted = decrypt_note(&kek[..], &encrypted_blob).unwrap();
    assert_eq!(decrypted, plaintext);
}

#[test]
fn test_unencrypted_roundtrip() {
    let profile_id = "550e8400-e29b-41d4-a716-446655440000";
    let plaintext = b"# Unencrypted Markdown Note\n\nPublic details here.";

    let blob = encode_unencrypted_note(profile_id, plaintext).unwrap();
    assert_eq!(&blob[0..4], MAGIC_MNTL);

    let decoded = decode_unencrypted_note(&blob).unwrap();
    assert_eq!(decoded, plaintext);
}

#[test]
fn test_extract_header_only() {
    let password = "MySecurePassword";
    let salt = b"random_salt_bytes";
    let profile_id = "profile-uuid-abc-123";
    let plaintext = b"Payload that should not be touched during indexing.";

    let kek = derive_kek(password, salt).unwrap();
    let encrypted_blob = encrypt_note(&kek[..], salt, profile_id, plaintext).unwrap();

    let header = extract_header_only(&encrypted_blob).unwrap();
    assert_eq!(header.v, CURRENT_VERSION);
    assert_eq!(header.credential_profile, profile_id);
    assert!(header.crypto.is_some());

    let unencrypted_blob = encode_unencrypted_note(profile_id, plaintext).unwrap();
    let header_unencrypted = extract_header_only(&unencrypted_blob).unwrap();
    assert_eq!(header_unencrypted.credential_profile, profile_id);
    assert!(header_unencrypted.crypto.is_none());
}

#[test]
fn test_tampered_header_fails_ad() {
    let password = "MySecurePassword";
    let salt = b"random_salt_bytes";
    let profile_id = "profile-uuid-abc-123";
    let plaintext = b"Secret note payload.";

    let kek = derive_kek(password, salt).unwrap();
    let mut encrypted_blob = encrypt_note(&kek[..], salt, profile_id, plaintext).unwrap();

    // Header JSON starts at offset 8. Let's tamper with 1 byte in the header JSON.
    encrypted_blob[12] ^= 0xFF;

    let result = decrypt_note(&kek[..], &encrypted_blob);
    assert!(result.is_err());
}

#[test]
fn test_tampered_ciphertext_fails() {
    let password = "MySecurePassword";
    let salt = b"random_salt_bytes";
    let profile_id = "profile-uuid-abc-123";
    let plaintext = b"Secret note payload.";

    let kek = derive_kek(password, salt).unwrap();
    let mut encrypted_blob = encrypt_note(&kek[..], salt, profile_id, plaintext).unwrap();

    // Ciphertext is at the end of the blob. Flip a bit in the last byte.
    let last_idx = encrypted_blob.len() - 1;
    encrypted_blob[last_idx] ^= 0x01;

    let result = decrypt_note(&kek[..], &encrypted_blob);
    match result {
        Err(MntlError::DecryptionFailed) => (),
        res => panic!("Expected DecryptionFailed error, got {:?}", res),
    }
}

#[test]
fn test_invalid_magic_bytes() {
    let kek = [0u8; 32];
    let corrupt_blob = b"BADM\x00\x00\x00\x05{...}";

    let result = decrypt_note(&kek, corrupt_blob);
    match result {
        Err(MntlError::InvalidMagicBytes) => (),
        res => panic!("Expected InvalidMagicBytes error, got {:?}", res),
    }
}

#[test]
fn test_custom_kdf_params() {
    let password = "PasswordWithCustomParams";
    let salt = b"salt_for_custom_params";
    let profile_id = "custom-profile";
    let plaintext = b"Custom KDF params payload";

    let custom_params = KdfParams {
        m_cost: 8192,
        t_cost: 2,
        p_cost: 1,
    };

    let kek = derive_kek_with_params(password, salt, &custom_params).unwrap();
    let blob =
        encrypt_note_with_params(&kek[..], salt, profile_id, plaintext, &custom_params).unwrap();

    let header = extract_header_only(&blob).unwrap();
    let crypto_meta = header.crypto.unwrap();
    assert_eq!(crypto_meta.kdf, custom_params);

    let decrypted = decrypt_note(&kek[..], &blob).unwrap();
    assert_eq!(decrypted, plaintext);
}
