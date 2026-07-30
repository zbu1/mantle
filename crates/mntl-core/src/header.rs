use serde::{Deserialize, Serialize};

pub const MAGIC_MNTL: &[u8; 4] = b"MNTL";
pub const MAGIC_MENC: &[u8; 4] = b"MENC";
pub const HEADER_OFFSET: usize = 8;
pub const CURRENT_VERSION: u8 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m_cost: 19456,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CryptoMeta {
    pub iv: String,
    pub salt: String,
    pub wrapped_key: String,
    pub kdf: KdfParams,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MntlHeader {
    pub v: u8,
    pub credential_profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crypto: Option<CryptoMeta>,
}

impl MntlHeader {
    pub fn new_encrypted(profile_id: impl Into<String>, crypto: CryptoMeta) -> Self {
        Self {
            v: CURRENT_VERSION,
            credential_profile: profile_id.into(),
            crypto: Some(crypto),
        }
    }

    pub fn new_unencrypted(profile_id: impl Into<String>) -> Self {
        Self {
            v: CURRENT_VERSION,
            credential_profile: profile_id.into(),
            crypto: None,
        }
    }
}
