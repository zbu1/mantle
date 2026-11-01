use mntl_core::{
    compute_verifier, decode_unencrypted_note, decrypt_note, derive_kek_with_params,
    encode_unencrypted_note, encrypt_note, extract_encrypted_header, extract_unencrypted_header,
    split_markdown_frontmatter, unwrap_master_key, verify_master_key,
    wrap_master_key, KdfParams, MasterKey, MntlError, ENVELOPE_VERSION, MAGIC_MENC, NOTE_VERSION,
};

/// Argon2id parameters cheap enough to run many times in a test suite. The
/// production default is 19 MiB, which makes a dozen derivations noticeably slow.
fn test_kdf() -> KdfParams {
    KdfParams {
        m_cost: 8192,
        t_cost: 1,
        p_cost: 1,
    }
}

/// A master key, without paying for a KDF run.
fn test_mk() -> MasterKey {
    MasterKey::generate().unwrap()
}

#[test]
fn test_derive_kek_deterministic() {
    let password = "SuperSecretPassword123!";
    let salt = b"unique_salt_1234";

    let kek1 = derive_kek_with_params(password, salt, &test_kdf()).unwrap();
    let kek2 = derive_kek_with_params(password, salt, &test_kdf()).unwrap();

    assert_eq!(kek1.expose(), kek2.expose());

    let kek_different = derive_kek_with_params("DifferentPassword", salt, &test_kdf()).unwrap();
    assert_ne!(kek1.expose(), kek_different.expose());
}

#[test]
fn test_derive_kek_uses_default_params() {
    // The one place the production cost is exercised, so a broken default
    // (e.g. parameters Argon2 rejects) fails loudly rather than only in the app.
    let kek = derive_kek_with_params("password", b"salt_bytes_here!", &KdfParams::default()).unwrap();
    assert_eq!(kek.expose().len(), 32);
}

#[test]
fn test_derive_kek_with_params_differs_by_cost() {
    let cheap = derive_kek_with_params("password", b"salt_bytes_here!", &test_kdf()).unwrap();
    let dearer = derive_kek_with_params(
        "password",
        b"salt_bytes_here!",
        &KdfParams {
            m_cost: 8192,
            t_cost: 2,
            p_cost: 1,
        },
    )
    .unwrap();

    assert_ne!(cheap.expose(), dearer.expose());
}

// --- Master key wrapping -------------------------------------------------

#[test]
fn test_master_key_wrap_unwrap_roundtrip() {
    let kek = derive_kek_with_params("hunter2", b"profile_salt_16b", &test_kdf()).unwrap();
    let mk = test_mk();

    let wrapped = wrap_master_key(&kek, &mk).unwrap();
    assert_eq!(wrapped.len(), 40);

    let recovered = unwrap_master_key(&kek, &wrapped).unwrap();
    assert_eq!(recovered.expose(), mk.expose());
}

#[test]
fn test_unwrap_master_key_wrong_password_is_key_wrap_error() {
    // Documents where a wrong password actually surfaces: AES-KW's integrity
    // check rejects it here, so callers see KeyWrapError and never reach the
    // AEAD. Anything mapping wrong-password to DecryptionFailed is wrong.
    let salt = b"profile_salt_16b";
    let right = derive_kek_with_params("hunter2", salt, &test_kdf()).unwrap();
    let wrong = derive_kek_with_params("hunter3", salt, &test_kdf()).unwrap();

    let wrapped = wrap_master_key(&right, &test_mk()).unwrap();

    match unwrap_master_key(&wrong, &wrapped) {
        Err(MntlError::KeyWrapError) => (),
        res => panic!("Expected KeyWrapError, got {res:?}"),
    }
}

#[test]
fn test_unwrap_master_key_rejects_wrong_length() {
    let kek = derive_kek_with_params("hunter2", b"profile_salt_16b", &test_kdf()).unwrap();
    match unwrap_master_key(&kek, &[0u8; 32]) {
        Err(MntlError::KeyWrapError) => (),
        res => panic!("Expected KeyWrapError, got {res:?}"),
    }
}

#[test]
fn test_verifier_stable_across_rewrap_with_new_password() {
    // The invariant that makes a future change-password cheap: rewrapping the
    // same master key under a new password leaves the verifier untouched, so
    // the stored verifier never has to be recomputed or migrated.
    let salt = b"profile_salt_16b";
    let mk = test_mk();
    let verifier = compute_verifier(&mk);

    let old_kek = derive_kek_with_params("old password", salt, &test_kdf()).unwrap();
    let wrapped_old = wrap_master_key(&old_kek, &mk).unwrap();

    let new_kek = derive_kek_with_params("new password", salt, &test_kdf()).unwrap();
    let wrapped_new = wrap_master_key(&new_kek, &mk).unwrap();

    assert_ne!(wrapped_old, wrapped_new, "rewrapping must change the blob");

    let recovered = unwrap_master_key(&new_kek, &wrapped_new).unwrap();
    assert!(verify_master_key(&recovered, &verifier));
    assert_eq!(compute_verifier(&recovered), verifier);
}

#[test]
fn test_verifier_rejects_a_different_master_key() {
    let verifier = compute_verifier(&test_mk());
    assert!(!verify_master_key(&test_mk(), &verifier));
}

#[test]
fn test_verifier_rejects_malformed_input() {
    assert!(!verify_master_key(&test_mk(), "not valid base64!!!"));
    assert!(!verify_master_key(&test_mk(), ""));
}

// --- Note encryption -----------------------------------------------------

#[test]
fn test_note_roundtrip_with_master_key() {
    let mk = test_mk();
    let plaintext = b"Hello, zero-knowledge world! This is confidential note data.";

    let blob = encrypt_note(&mk, "my-diary", plaintext).unwrap();
    assert_eq!(&blob[0..4], MAGIC_MENC);

    let decrypted = decrypt_note(&mk, &blob).unwrap();
    assert_eq!(&decrypted[..], plaintext);
}

#[test]
fn test_envelope_seals_arbitrary_binary() {
    // Image attachments reuse the note envelope with raw bytes as the payload.
    let mk = test_mk();
    let image: Vec<u8> = (0..=255u8).cycle().take(4096).collect();

    let blob = encrypt_note(&mk, "my-diary", &image).unwrap();
    assert_eq!(&decrypt_note(&mk, &blob).unwrap()[..], &image[..]);
}

#[test]
fn test_decrypt_with_wrong_master_key_is_key_wrap_error() {
    let blob = encrypt_note(&test_mk(), "my-diary", b"payload").unwrap();

    match decrypt_note(&test_mk(), &blob) {
        Err(MntlError::KeyWrapError) => (),
        res => panic!("Expected KeyWrapError, got {res:?}"),
    }
}

#[test]
fn test_two_notes_under_same_mk_have_distinct_cek_and_nonce() {
    // Guards against an "optimization" that reuses one content key or nonce
    // across notes, which would be a real nonce-reuse break.
    let mk = test_mk();

    let a = encrypt_note(&mk, "my-diary", b"first note").unwrap();
    let b = encrypt_note(&mk, "my-diary", b"second note").unwrap();

    let ha = extract_encrypted_header(&a).unwrap();
    let hb = extract_encrypted_header(&b).unwrap();

    assert_ne!(ha.crypto.iv, hb.crypto.iv);
    assert_ne!(ha.crypto.wrapped_key, hb.crypto.wrapped_key);
}

#[test]
fn test_rewriting_a_note_generates_fresh_cek_and_nonce() {
    // Overwriting a note must never carry the old header forward.
    let mk = test_mk();
    let first = encrypt_note(&mk, "my-diary", b"same content").unwrap();
    let second = encrypt_note(&mk, "my-diary", b"same content").unwrap();

    let h1 = extract_encrypted_header(&first).unwrap();
    let h2 = extract_encrypted_header(&second).unwrap();

    assert_ne!(h1.crypto.iv, h2.crypto.iv);
    assert_ne!(h1.crypto.wrapped_key, h2.crypto.wrapped_key);
    assert_ne!(first, second);
}

#[test]
fn test_encrypted_payload_is_a_full_mntl_document() {
    // The payload is a whole `.mntl` file, frontmatter included, so the note
    // format can gain fields without touching the envelope or its AAD.
    let mk = test_mk();
    let content = "# Dream journal\n\nI was flying again.";

    let document = encode_unencrypted_note(content).unwrap();
    let blob = encrypt_note(&mk, "my-diary", document.as_bytes()).unwrap();

    let decrypted = decrypt_note(&mk, &blob).unwrap();
    let recovered = std::str::from_utf8(&decrypted).unwrap();

    assert!(recovered.starts_with("---\nv: 2\n---\n"));
    assert_eq!(decode_unencrypted_note(recovered).unwrap(), content);
}

#[test]
fn test_profile_id_is_readable_without_the_key() {
    // The whole point of a cleartext profile id: group and route notes with no
    // key in hand.
    let blob = encrypt_note(&test_mk(), "my-diary", b"payload").unwrap();

    let header = extract_encrypted_header(&blob).unwrap();
    assert_eq!(header.credential_profile, "my-diary");
    assert_eq!(header.v, ENVELOPE_VERSION);
}

#[test]
fn test_header_json_has_exactly_the_expected_keys() {
    // Freezes the wire format. The header bytes are the AAD, so an
    // accidentally added, renamed or reordered field silently invalidates
    // every note already on disk.
    let blob = encrypt_note(&test_mk(), "my-diary", b"payload").unwrap();

    let header_len = u32::from_le_bytes(blob[4..8].try_into().unwrap()) as usize;
    let header_json = std::str::from_utf8(&blob[8..8 + header_len]).unwrap();

    // Assert on the raw bytes, not a parsed Value: serde_json::Value sorts its
    // keys, which would hide exactly the field-order change this test exists
    // to catch.
    assert!(
        header_json.starts_with(r#"{"v":3,"credential_profile":"my-diary","crypto":{"iv":""#),
        "unexpected header shape: {header_json}"
    );
    assert!(
        header_json.contains(r#"","wrapped_key":""#),
        "unexpected header shape: {header_json}"
    );
    assert!(header_json.ends_with("\"}}"));

    // And no fields beyond those four.
    let parsed: serde_json::Value = serde_json::from_str(header_json).unwrap();
    assert_eq!(parsed.as_object().unwrap().len(), 3);
    assert_eq!(parsed["crypto"].as_object().unwrap().len(), 2);
}

// --- Versioning ----------------------------------------------------------

#[test]
fn test_note_and_envelope_versions_are_independent() {
    assert_eq!(NOTE_VERSION, 2);
    assert_eq!(ENVELOPE_VERSION, 3);

    // The reason the constants were split: bumping the envelope must not
    // reject plaintext notes already on disk.
    let handwritten = "---\nv: 2\n---\n# Still fine\n";
    assert_eq!(
        decode_unencrypted_note(handwritten).unwrap(),
        "# Still fine\n"
    );
}

#[test]
fn test_decrypt_rejects_envelope_version_2() {
    let mk = test_mk();
    let mut blob = encrypt_note(&mk, "my-diary", b"payload").unwrap();

    // Rewrite `"v":3` to `"v":2` in the header JSON.
    let header_len = u32::from_le_bytes(blob[4..8].try_into().unwrap()) as usize;
    let header = std::str::from_utf8(&blob[8..8 + header_len]).unwrap();
    let downgraded = header.replacen("\"v\":3", "\"v\":2", 1);
    assert_ne!(header, downgraded, "expected to find the version field");
    blob[8..8 + header_len].copy_from_slice(downgraded.as_bytes());

    match decrypt_note(&mk, &blob) {
        Err(MntlError::UnsupportedVersion(2)) => (),
        res => panic!("Expected UnsupportedVersion(2), got {res:?}"),
    }
}

#[test]
fn test_unsupported_note_version_is_rejected() {
    match decode_unencrypted_note("---\nv: 99\n---\nbody") {
        Err(MntlError::UnsupportedVersion(99)) => (),
        res => panic!("Expected UnsupportedVersion(99), got {res:?}"),
    }
}

// --- Tampering -----------------------------------------------------------

#[test]
fn test_tampered_header_fails_ad() {
    let mk = test_mk();
    let mut blob = encrypt_note(&mk, "my-diary", b"Secret note payload.").unwrap();

    // Header JSON starts at offset 8; flip a byte inside it.
    blob[12] ^= 0xFF;

    assert!(decrypt_note(&mk, &blob).is_err());
}

#[test]
fn test_tampered_profile_id_fails_ad() {
    // A hand-edited profile id is the realistic way a header gets tampered
    // with, and it must fail rather than quietly decrypt under a new name.
    let mk = test_mk();
    let blob = encrypt_note(&mk, "my-diary", b"Secret note payload.").unwrap();

    let header_len = u32::from_le_bytes(blob[4..8].try_into().unwrap()) as usize;
    let header = std::str::from_utf8(&blob[8..8 + header_len]).unwrap();
    let edited = header.replacen("my-diary", "the-work", 1);
    assert_eq!(edited.len(), header.len(), "replacement must keep length");

    let mut tampered = blob.clone();
    tampered[8..8 + header_len].copy_from_slice(edited.as_bytes());

    match decrypt_note(&mk, &tampered) {
        Err(MntlError::DecryptionFailed) => (),
        res => panic!("Expected DecryptionFailed, got {res:?}"),
    }
}

#[test]
fn test_tampered_ciphertext_fails() {
    let mk = test_mk();
    let mut blob = encrypt_note(&mk, "my-diary", b"Secret note payload.").unwrap();

    let last = blob.len() - 1;
    blob[last] ^= 0x01;

    match decrypt_note(&mk, &blob) {
        Err(MntlError::DecryptionFailed) => (),
        res => panic!("Expected DecryptionFailed, got {res:?}"),
    }
}

#[test]
fn test_invalid_magic_bytes() {
    let corrupt = b"BADM\x00\x00\x00\x05{...}";

    match decrypt_note(&test_mk(), corrupt) {
        Err(MntlError::InvalidMagicBytes) => (),
        res => panic!("Expected InvalidMagicBytes, got {res:?}"),
    }
}

#[test]
fn test_truncated_blob_is_rejected() {
    let blob = encrypt_note(&test_mk(), "my-diary", b"payload").unwrap();

    match decrypt_note(&test_mk(), &blob[..6]) {
        Err(MntlError::InvalidHeaderSize) => (),
        res => panic!("Expected InvalidHeaderSize, got {res:?}"),
    }
}

// --- Plaintext `.mntl` format --------------------------------------------

#[test]
fn test_unencrypted_roundtrip() {
    let content = "# Unencrypted Markdown Note\n\nPublic details here.";

    let file = encode_unencrypted_note(content).unwrap();

    // The file is a plain, human-readable YAML-frontmatter Markdown document.
    assert!(file.starts_with("---\nv: 2\n---\n"));
    assert!(file.contains(content));

    let decoded = decode_unencrypted_note(&file).unwrap();
    assert_eq!(decoded, content);
}

#[test]
fn test_unencrypted_roundtrip_empty_body() {
    let file = encode_unencrypted_note("").unwrap();
    let decoded = decode_unencrypted_note(&file).unwrap();
    assert_eq!(decoded, "");
}

#[test]
fn test_unencrypted_body_containing_delimiter_line() {
    // A body that itself contains a line of exactly "---" (e.g. a Markdown
    // horizontal rule) must not be mistaken for the frontmatter close.
    let content = "Above\n\n---\n\nBelow";

    let file = encode_unencrypted_note(content).unwrap();
    let decoded = decode_unencrypted_note(&file).unwrap();
    assert_eq!(decoded, content);
}

#[test]
fn test_extract_headers() {
    let blob = encrypt_note(&test_mk(), "profile-uuid-abc-123", b"Payload.").unwrap();

    let header = extract_encrypted_header(&blob).unwrap();
    assert_eq!(header.v, ENVELOPE_VERSION);
    assert_eq!(header.credential_profile, "profile-uuid-abc-123");

    let file = encode_unencrypted_note("Body that should not be touched.").unwrap();
    assert_eq!(extract_unencrypted_header(&file).unwrap().v, NOTE_VERSION);
}

#[test]
fn test_tags_roundtrip_through_the_frontmatter_and_the_envelope() {
    let frontmatter = mntl_core::NoteFrontmatter {
        tags: vec!["reference".into(), "Q3".into()],
        ..Default::default()
    };
    let file = mntl_core::encode_note(&frontmatter, "Body").unwrap();
    assert_eq!(file, "---\nv: 2\ntags:\n- reference\n- Q3\n---\nBody");

    let mk = test_mk();
    let blob = encrypt_note(&mk, "profile", file.as_bytes()).unwrap();
    let recovered = decrypt_note(&mk, &blob).unwrap();
    let (decoded, body) = mntl_core::decode_note(std::str::from_utf8(&recovered).unwrap()).unwrap();
    assert_eq!(decoded, frontmatter);
    assert_eq!(body, "Body");
}

#[test]
fn test_a_note_without_tags_has_none_and_writes_no_key() {
    let (frontmatter, _) = mntl_core::decode_note("---\nv: 2\n---\nBody").unwrap();
    assert!(frontmatter.tags.is_empty());
    assert_eq!(encode_unencrypted_note("Body").unwrap(), "---\nv: 2\n---\nBody");
}

#[test]
fn test_missing_frontmatter_fails() {
    let result = decode_unencrypted_note("Just plain text, no frontmatter at all.");
    assert!(matches!(result, Err(MntlError::MissingFrontmatter)));
}

#[test]
fn test_markdown_frontmatter_is_split_off_verbatim() {
    let file = "---
tags: [a, b]
---
# Title
";
    let (frontmatter, body) = split_markdown_frontmatter(file);
    assert_eq!(frontmatter, "---
tags: [a, b]
---
");
    assert_eq!(body, "# Title
");
}

#[test]
fn test_markdown_without_frontmatter_is_all_body() {
    for file in ["# Title
", "---
an unclosed rule
", ""] {
        assert_eq!(split_markdown_frontmatter(file), ("", file));
    }
}

// --- Golden fixture ------------------------------------------------------

/// The master key the fixture below was sealed under. Committed deliberately;
/// it protects nothing.
const GOLDEN_MASTER_KEY: [u8; 32] = [
    0x9e, 0x3f, 0xa1, 0x07, 0x5c, 0xd2, 0x48, 0xb6, 0x11, 0x8a, 0x30, 0xe5, 0x7d, 0x42, 0xcb, 0x96,
    0x24, 0xf0, 0x8d, 0x53, 0xa7, 0x1c, 0x6b, 0xde, 0x35, 0x92, 0x4e, 0x08, 0xbf, 0x71, 0xd6, 0x2a,
];

/// A real `.mntl.enc` envelope produced by this crate, frozen byte for byte.
///
/// Every other test in this file encrypts and decrypts in the same process, so
/// all of them would still pass if the format changed in a self-consistent
/// way. This one cannot: it is the only test that fails if a refactor breaks
/// compatibility with envelopes already on disk.
///
/// The likeliest such refactor is "tidying" `decrypt_note` to rebuild the AAD
/// with `serde_json::to_vec(&header)` instead of using the header bytes as
/// they appear in the file. That works until serde emits one byte differently
/// and then silently fails to decrypt every note a user owns.
///
/// **Do not regenerate this fixture to make a failing test pass.** A failure
/// here means real files stopped decrypting.
#[rustfmt::skip]
const GOLDEN_ENVELOPE: [u8; 236] = [
    0x4d, 0x45, 0x4e, 0x43, 0xa3, 0x00, 0x00, 0x00, 0x7b, 0x22, 0x76, 0x22,
    0x3a, 0x33, 0x2c, 0x22, 0x63, 0x72, 0x65, 0x64, 0x65, 0x6e, 0x74, 0x69,
    0x61, 0x6c, 0x5f, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x6c, 0x65, 0x22, 0x3a,
    0x22, 0x6d, 0x79, 0x2d, 0x64, 0x69, 0x61, 0x72, 0x79, 0x22, 0x2c, 0x22,
    0x63, 0x72, 0x79, 0x70, 0x74, 0x6f, 0x22, 0x3a, 0x7b, 0x22, 0x69, 0x76,
    0x22, 0x3a, 0x22, 0x35, 0x41, 0x6d, 0x57, 0x31, 0x4d, 0x71, 0x61, 0x62,
    0x75, 0x55, 0x56, 0x54, 0x36, 0x62, 0x6c, 0x68, 0x42, 0x35, 0x46, 0x34,
    0x4d, 0x78, 0x76, 0x32, 0x6c, 0x4b, 0x4d, 0x38, 0x37, 0x35, 0x55, 0x22,
    0x2c, 0x22, 0x77, 0x72, 0x61, 0x70, 0x70, 0x65, 0x64, 0x5f, 0x6b, 0x65,
    0x79, 0x22, 0x3a, 0x22, 0x4b, 0x6e, 0x35, 0x38, 0x5a, 0x30, 0x45, 0x36,
    0x4d, 0x7a, 0x43, 0x50, 0x46, 0x6f, 0x7a, 0x57, 0x45, 0x7a, 0x79, 0x62,
    0x72, 0x70, 0x2b, 0x37, 0x47, 0x37, 0x52, 0x48, 0x31, 0x65, 0x6f, 0x57,
    0x42, 0x6f, 0x6e, 0x32, 0x55, 0x53, 0x66, 0x36, 0x51, 0x75, 0x6f, 0x65,
    0x30, 0x76, 0x44, 0x6b, 0x59, 0x41, 0x37, 0x63, 0x6f, 0x67, 0x3d, 0x3d,
    0x22, 0x7d, 0x7d, 0xca, 0xdb, 0x2c, 0xa1, 0x02, 0x44, 0x14, 0x5d, 0x27,
    0x78, 0xcf, 0x46, 0xd2, 0x67, 0x6a, 0xdb, 0xe0, 0xea, 0x17, 0x64, 0x2d,
    0xa6, 0xe3, 0xdc, 0xe8, 0x93, 0x32, 0x8b, 0x9d, 0x88, 0xfe, 0xc9, 0x07,
    0xe5, 0x0d, 0xf3, 0x8e, 0x7d, 0x51, 0x90, 0xd0, 0x54, 0xfa, 0xb7, 0x45,
    0xfb, 0xdb, 0xce, 0x59, 0x53, 0xfc, 0xab, 0x6e, 0x0c, 0x0b, 0xc7, 0x1f,
    0x8e, 0x7c, 0xb6, 0xe3, 0x3c, 0x84, 0xb2, 0x86,
];

#[test]
fn test_decrypts_a_golden_fixture_blob() {
    let mk = MasterKey::from_bytes(GOLDEN_MASTER_KEY);

    let header = extract_encrypted_header(&GOLDEN_ENVELOPE).unwrap();
    assert_eq!(header.v, ENVELOPE_VERSION);
    assert_eq!(header.credential_profile, "my-diary");

    let decrypted = decrypt_note(&mk, &GOLDEN_ENVELOPE).unwrap();
    let document = std::str::from_utf8(&decrypted).unwrap();

    assert_eq!(
        decode_unencrypted_note(document).unwrap(),
        "# Golden fixture\n\nDo not regenerate."
    );
}

/// [`GOLDEN_ENVELOPE`]'s twin for a hidden note: the same key, a header with
/// `"hidden":true`, and a sealed location and name. Frozen for the same
/// reason — **do not regenerate it**.
#[rustfmt::skip]
const GOLDEN_HIDDEN_ENVELOPE: [u8; 260] = [
    0x4d, 0x45, 0x4e, 0x43, 0xb1, 0x00, 0x00, 0x00, 0x7b, 0x22, 0x76, 0x22,
    0x3a, 0x33, 0x2c, 0x22, 0x63, 0x72, 0x65, 0x64, 0x65, 0x6e, 0x74, 0x69,
    0x61, 0x6c, 0x5f, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x6c, 0x65, 0x22, 0x3a,
    0x22, 0x6d, 0x79, 0x2d, 0x64, 0x69, 0x61, 0x72, 0x79, 0x22, 0x2c, 0x22,
    0x63, 0x72, 0x79, 0x70, 0x74, 0x6f, 0x22, 0x3a, 0x7b, 0x22, 0x69, 0x76,
    0x22, 0x3a, 0x22, 0x4a, 0x36, 0x32, 0x33, 0x31, 0x6f, 0x2b, 0x65, 0x33,
    0x46, 0x72, 0x47, 0x38, 0x37, 0x65, 0x76, 0x31, 0x6c, 0x69, 0x4f, 0x5a,
    0x76, 0x30, 0x48, 0x73, 0x79, 0x66, 0x58, 0x4a, 0x6f, 0x69, 0x4b, 0x22,
    0x2c, 0x22, 0x77, 0x72, 0x61, 0x70, 0x70, 0x65, 0x64, 0x5f, 0x6b, 0x65,
    0x79, 0x22, 0x3a, 0x22, 0x76, 0x4f, 0x70, 0x42, 0x6a, 0x44, 0x43, 0x59,
    0x54, 0x36, 0x76, 0x78, 0x68, 0x69, 0x30, 0x39, 0x57, 0x6b, 0x64, 0x66,
    0x68, 0x73, 0x63, 0x65, 0x2b, 0x41, 0x35, 0x74, 0x44, 0x4c, 0x6c, 0x69,
    0x48, 0x41, 0x52, 0x4d, 0x46, 0x71, 0x31, 0x6b, 0x56, 0x6f, 0x44, 0x79,
    0x35, 0x72, 0x62, 0x48, 0x35, 0x4f, 0x67, 0x57, 0x70, 0x77, 0x3d, 0x3d,
    0x22, 0x7d, 0x2c, 0x22, 0x68, 0x69, 0x64, 0x64, 0x65, 0x6e, 0x22, 0x3a,
    0x74, 0x72, 0x75, 0x65, 0x7d, 0x8e, 0xcd, 0x8d, 0x38, 0x49, 0x36, 0xb5,
    0x7a, 0xac, 0x4f, 0x74, 0xa7, 0xb6, 0xb7, 0x73, 0x64, 0x0c, 0xf1, 0xfd,
    0xa8, 0x7f, 0xe2, 0x73, 0x4e, 0xd1, 0x5d, 0x09, 0x3e, 0x24, 0xed, 0xe6,
    0xf2, 0x6a, 0xdd, 0x0b, 0x94, 0x18, 0x27, 0xba, 0x42, 0x23, 0x45, 0x6b,
    0x47, 0x15, 0x65, 0x89, 0x9f, 0x07, 0xfc, 0xea, 0x7f, 0x1f, 0x08, 0xed,
    0x0a, 0x2f, 0x2e, 0x83, 0x14, 0x21, 0x97, 0xe2, 0x7f, 0x99, 0x36, 0xba,
    0xf3, 0x63, 0xdd, 0xf0, 0xcd, 0x45, 0xcd, 0x64,
];

#[test]
fn test_decrypts_a_golden_hidden_fixture_blob() {
    let mk = MasterKey::from_bytes(GOLDEN_MASTER_KEY);

    let header = extract_encrypted_header(&GOLDEN_HIDDEN_ENVELOPE).unwrap();
    assert!(header.hidden);
    assert!(!extract_encrypted_header(&GOLDEN_ENVELOPE).unwrap().hidden);

    let decrypted = decrypt_note(&mk, &GOLDEN_HIDDEN_ENVELOPE).unwrap();
    let (frontmatter, body) = mntl_core::decode_note(std::str::from_utf8(&decrypted).unwrap()).unwrap();
    assert_eq!(frontmatter.location.as_deref(), Some("Journal"));
    assert_eq!(frontmatter.name.as_deref(), Some("Golden"));
    assert_eq!(body, "Hidden fixture.");

    // The flag is AAD: stripping it from the header breaks decryption.
    let header_end = 8 + 0xb1;
    let stripped = String::from_utf8_lossy(&GOLDEN_HIDDEN_ENVELOPE[8..header_end]).replace(",\"hidden\":true", "");
    let mut blob = Vec::from(&GOLDEN_HIDDEN_ENVELOPE[..4]);
    blob.extend_from_slice(&(stripped.len() as u32).to_le_bytes());
    blob.extend_from_slice(stripped.as_bytes());
    blob.extend_from_slice(&GOLDEN_HIDDEN_ENVELOPE[header_end..]);
    assert!(!extract_encrypted_header(&blob).unwrap().hidden);
    assert!(matches!(decrypt_note(&mk, &blob), Err(MntlError::DecryptionFailed)));
}

#[test]
fn test_encodes_a_note_as_markdown() {
    let mut frontmatter = mntl_core::NoteFrontmatter { tags: vec!["idea".into()], ..Default::default() };
    frontmatter.properties.insert("due".into(), "2026-10-17".into());
    let md = mntl_core::encode_markdown_note(&frontmatter, "Body").unwrap();
    assert_eq!(md, "---\ntags:\n- idea\ndue: 2026-10-17\n---\nBody");
    assert_eq!(mntl_core::markdown_tags(&md), ["idea"]);

    let bare = mntl_core::NoteFrontmatter::default();
    assert_eq!(mntl_core::encode_markdown_note(&bare, "Body").unwrap(), "Body");
    let rule = "---\nnot: frontmatter\n---\nBody";
    assert_eq!(split_markdown_frontmatter(&mntl_core::encode_markdown_note(&bare, rule).unwrap()).1, rule);
}

/// A chunked envelope written once by `encrypt_stream` under
/// [`GOLDEN_MASTER_KEY`], 12 bytes to a chunk. Like [`GOLDEN_ENVELOPE`], it
/// pins the format: if this stops decrypting, existing sealed videos and PDFs
/// would too.
const GOLDEN_STREAM: [u8; 254] = [
    0x4d, 0x45, 0x4e, 0x43, 0xa8, 0x00, 0x00, 0x00, 0x7b, 0x22, 0x76, 0x22,
    0x3a, 0x34, 0x2c, 0x22, 0x63, 0x72, 0x65, 0x64, 0x65, 0x6e, 0x74, 0x69,
    0x61, 0x6c, 0x5f, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x6c, 0x65, 0x22, 0x3a,
    0x22, 0x67, 0x6f, 0x6c, 0x64, 0x65, 0x6e, 0x22, 0x2c, 0x22, 0x63, 0x72,
    0x79, 0x70, 0x74, 0x6f, 0x22, 0x3a, 0x7b, 0x22, 0x69, 0x76, 0x22, 0x3a,
    0x22, 0x79, 0x6e, 0x72, 0x7a, 0x4a, 0x76, 0x45, 0x39, 0x31, 0x66, 0x51,
    0x74, 0x6f, 0x66, 0x6a, 0x4e, 0x6e, 0x42, 0x6c, 0x30, 0x33, 0x63, 0x44,
    0x50, 0x55, 0x67, 0x3d, 0x3d, 0x22, 0x2c, 0x22, 0x77, 0x72, 0x61, 0x70,
    0x70, 0x65, 0x64, 0x5f, 0x6b, 0x65, 0x79, 0x22, 0x3a, 0x22, 0x4f, 0x59,
    0x77, 0x68, 0x6d, 0x78, 0x57, 0x73, 0x4a, 0x64, 0x6c, 0x45, 0x69, 0x57,
    0x75, 0x33, 0x42, 0x48, 0x2f, 0x33, 0x72, 0x65, 0x56, 0x45, 0x75, 0x74,
    0x32, 0x77, 0x6b, 0x2b, 0x65, 0x6e, 0x57, 0x6b, 0x71, 0x4a, 0x35, 0x74,
    0x4a, 0x39, 0x69, 0x6f, 0x54, 0x4f, 0x61, 0x4d, 0x49, 0x43, 0x4f, 0x7a,
    0x6e, 0x5a, 0x38, 0x77, 0x3d, 0x3d, 0x22, 0x7d, 0x2c, 0x22, 0x63, 0x68,
    0x75, 0x6e, 0x6b, 0x22, 0x3a, 0x31, 0x32, 0x7d, 0x8c, 0xf4, 0x8a, 0x46,
    0xeb, 0x85, 0x72, 0xc7, 0x07, 0x27, 0x84, 0x7e, 0xf4, 0xa5, 0xa2, 0xc3,
    0x66, 0x66, 0xbf, 0xf8, 0x28, 0x60, 0x81, 0xe3, 0x19, 0x9d, 0x00, 0x1b,
    0x39, 0xf3, 0x14, 0x4d, 0x21, 0x05, 0xe1, 0xe2, 0x46, 0x0f, 0x65, 0xcf,
    0x35, 0xd2, 0x6f, 0xb4, 0x77, 0xd8, 0x19, 0x07, 0x35, 0x3f, 0x1b, 0xe7,
    0x77, 0xe4, 0x28, 0x42, 0x94, 0x8a, 0x18, 0xc0, 0x1a, 0x96, 0x6f, 0x04,
    0xb7, 0x23, 0x65, 0x7b, 0x9e, 0x8d, 0x0c, 0x89, 0xa2, 0x3f, 0xdd, 0x2c,
    0x1a, 0x38,
];

const GOLDEN_STREAM_PLAINTEXT: &[u8] = b"Chunked fixture, three chunks.";

#[test]
fn test_decrypts_a_golden_chunked_fixture_whole_and_by_range() {
    let mk = MasterKey::from_bytes(GOLDEN_MASTER_KEY);
    let header = extract_encrypted_header(&GOLDEN_STREAM).unwrap();
    assert_eq!((header.v, header.chunk, header.credential_profile.as_str()), (mntl_core::STREAM_VERSION, Some(12), "golden"));
    assert_eq!(&decrypt_note(&mk, &GOLDEN_STREAM).unwrap()[..], GOLDEN_STREAM_PLAINTEXT);

    let stream = mntl_core::SealedStream::open(&mk, &GOLDEN_STREAM[..200], GOLDEN_STREAM.len() as u64).unwrap();
    assert_eq!(stream.len(), GOLDEN_STREAM_PLAINTEXT.len() as u64);
    let span = stream.chunks_for(14, 20);
    assert_eq!((span.first, span.plaintext_offset), (1, 12));
    let sealed = &GOLDEN_STREAM[span.file_offset as usize..(span.file_offset + span.file_len) as usize];
    let plain = stream.decrypt_chunks(span.first, sealed).unwrap();
    assert_eq!(&plain[..], &GOLDEN_STREAM_PLAINTEXT[12..24]);
}

#[test]
fn test_chunked_envelopes_refuse_reordering_truncation_and_tampering() {
    let mk = test_mk();
    let plaintext: Vec<u8> = (0..100u8).collect();
    let blob = mntl_core::encrypt_stream(&mk, "p", &plaintext, 16).unwrap();
    assert_eq!(&decrypt_note(&mk, &blob).unwrap()[..], &plaintext[..]);
    assert_eq!(decrypt_note(&mk, &mntl_core::encrypt_stream(&mk, "p", b"", 16).unwrap()).unwrap().len(), 0);

    let stream = mntl_core::SealedStream::open(&mk, &blob, blob.len() as u64).unwrap();
    let offset = stream.chunks_for(0, 1).file_offset;
    let chunk = 16 + 16;
    // Cut at a chunk boundary: the new last chunk was never sealed as last.
    let cut = &blob[..offset as usize + 2 * chunk];
    assert!(matches!(decrypt_note(&mk, cut), Err(MntlError::DecryptionFailed)));
    // Swap the first two chunks.
    let mut swapped = blob.clone();
    let start = offset as usize;
    swapped[start..start + 2 * chunk].rotate_left(chunk);
    assert!(matches!(decrypt_note(&mk, &swapped), Err(MntlError::DecryptionFailed)));
    let mut flipped = blob.clone();
    *flipped.last_mut().unwrap() ^= 1;
    assert!(matches!(decrypt_note(&mk, &flipped), Err(MntlError::DecryptionFailed)));
}

#[test]
fn test_rotate_envelope_reseals_every_envelope_kind_and_is_resumable() {
    let (old, new) = (test_mk(), mntl_core::MasterKey::generate().unwrap());
    let plain = b"secret body".to_vec();
    let blobs = [
        mntl_core::encrypt_note(&old, "p", &plain).unwrap(),
        mntl_core::encrypt_note_as(&old, "p", true, &plain).unwrap(),
        mntl_core::encrypt_stream(&old, "p", &plain, 4).unwrap(),
    ];
    for blob in &blobs {
        let rotated = mntl_core::rotate_envelope(&old, &new, blob).unwrap().unwrap();
        assert_eq!(&decrypt_note(&new, &rotated).unwrap()[..], &plain[..]);
        assert!(decrypt_note(&old, &rotated).is_err());
        let (before, after) = (mntl_core::extract_encrypted_header(blob).unwrap(), mntl_core::extract_encrypted_header(&rotated).unwrap());
        assert_eq!((before.hidden, before.chunk, before.v), (after.hidden, after.chunk, after.v));
        assert!(mntl_core::rotate_envelope(&old, &new, &rotated).unwrap().is_none());
    }
    let stranger = mntl_core::MasterKey::generate().unwrap();
    assert!(mntl_core::rotate_envelope(&old, &new, &mntl_core::encrypt_note(&stranger, "p", b"x").unwrap()).is_err());
}

#[test]
fn test_derive_kek_rejects_absurd_cost_parameters() {
    use mntl_core::{derive_kek_with_params, KdfParams};
    let huge = KdfParams { m_cost: u32::MAX, t_cost: 1, p_cost: 1 };
    assert!(derive_kek_with_params("pw", b"saltsaltsalt", &huge).is_err());
    let slow = KdfParams { m_cost: 8, t_cost: 1000, p_cost: 1 };
    assert!(derive_kek_with_params("pw", b"saltsaltsalt", &slow).is_err());
}

#[test]
fn test_oversized_header_length_is_rejected_not_wrapped() {
    let mut blob = b"MENC".to_vec();
    blob.extend_from_slice(&u32::MAX.to_le_bytes());
    blob.extend_from_slice(b"{}");
    assert!(mntl_core::extract_encrypted_header(&blob).is_err());
}
