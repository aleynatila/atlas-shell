//! Saved-password storage used on macOS instead of the Keychain.
//!
//! The macOS build is ad-hoc signed, so after every update the Keychain sees a
//! new app and asks again for each saved password. Here the passwords live in an
//! AES-256-GCM encrypted file in the app data dir. The key sits next to it with
//! owner-only permissions: this keeps passwords out of plain sight, but anything
//! running as the user can read them, which the Keychain would not allow.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use zeroize::{Zeroize, Zeroizing};

const KEY_FILE: &str = "credentials.key";
const DATA_FILE: &str = "credentials.bin";
const NONCE_LEN: usize = 12;

/// Serializes load-modify-save; credential commands run on a thread pool.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
struct Vault {
    passwords: BTreeMap<String, String>,
    /// Ids whose old Keychain entry was already looked up (moved here, absent or
    /// denied), so the Keychain is never asked about them again.
    #[serde(default)]
    legacy_checked: BTreeSet<String>,
}

impl Drop for Vault {
    fn drop(&mut self) {
        for p in self.passwords.values_mut() {
            p.zeroize();
        }
    }
}

/// Write via a temp file + rename so a crash never leaves a half-written file.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(&tmp, path)
}

fn load_key(dir: &Path) -> Result<Zeroizing<[u8; 32]>, String> {
    let path = dir.join(KEY_FILE);
    let mut key = Zeroizing::new([0u8; 32]);
    match fs::read(&path) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            if bytes.len() != key.len() {
                return Err("credential key file is corrupt".into());
            }
            key.copy_from_slice(&bytes);
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            key.copy_from_slice(&Aes256Gcm::generate_key(OsRng));
            write_private(&path, &key[..]).map_err(|e| e.to_string())?;
        }
        Err(e) => return Err(e.to_string()),
    }
    Ok(key)
}

fn load(dir: &Path, key: &[u8; 32]) -> Result<Vault, String> {
    let path = dir.join(DATA_FILE);
    let data = match fs::read(&path) {
        Ok(d) => d,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vault::default()),
        Err(e) => return Err(e.to_string()),
    };
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plain = (data.len() > NONCE_LEN)
        .then(|| cipher.decrypt(Nonce::from_slice(&data[..NONCE_LEN]), &data[NONCE_LEN..]).ok())
        .flatten()
        .map(Zeroizing::new);
    match plain.and_then(|p| serde_json::from_slice(&p).ok()) {
        Some(vault) => Ok(vault),
        None => {
            // Unreadable (e.g. the key file was lost): set it aside and start
            // empty, otherwise no password could ever be saved again.
            let _ = fs::rename(&path, path.with_extension("unreadable"));
            Ok(Vault::default())
        }
    }
}

fn save(dir: &Path, key: &[u8; 32], vault: &Vault) -> Result<(), String> {
    let plain = Zeroizing::new(serde_json::to_vec(vault).map_err(|e| e.to_string())?);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut out = nonce.to_vec();
    out.extend(cipher.encrypt(&nonce, plain.as_slice()).map_err(|e| e.to_string())?);
    write_private(&dir.join(DATA_FILE), &out).map_err(|e| e.to_string())
}

fn with_vault<T>(dir: &Path, f: impl FnOnce(&mut Vault) -> (T, bool)) -> Result<T, String> {
    let _guard = LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let key = load_key(dir)?;
    let mut vault = load(dir, &key)?;
    let (out, changed) = f(&mut vault);
    if changed {
        save(dir, &key, &vault)?;
    }
    Ok(out)
}

/// Look up a password. `legacy` is called at most once per id to move an entry
/// saved by older versions (in the Keychain) into this store.
pub fn get(dir: &Path, id: &str, legacy: impl FnOnce() -> Option<String>) -> Result<Option<String>, String> {
    with_vault(dir, |v| {
        if let Some(p) = v.passwords.get(id) {
            return (Some(p.clone()), false);
        }
        if v.legacy_checked.contains(id) {
            return (None, false);
        }
        let found = legacy();
        if let Some(p) = &found {
            v.passwords.insert(id.to_string(), p.clone());
        }
        v.legacy_checked.insert(id.to_string());
        (found, true)
    })
}

pub fn set(dir: &Path, id: &str, password: &str) -> Result<(), String> {
    with_vault(dir, |v| {
        v.passwords.insert(id.to_string(), password.to_string());
        v.legacy_checked.insert(id.to_string());
        ((), true)
    })
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    with_vault(dir, |v| {
        v.passwords.remove(id);
        v.legacy_checked.insert(id.to_string());
        ((), true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("atlas-cred-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn set_get_delete_round_trip() {
        let dir = temp_dir();
        assert_eq!(get(&dir, "a", || None).unwrap(), None);
        set(&dir, "a", "hunter2").unwrap();
        set(&dir, "b", "pässwörd").unwrap();
        assert_eq!(get(&dir, "a", || panic!("no legacy lookup")).unwrap().as_deref(), Some("hunter2"));
        assert_eq!(get(&dir, "b", || None).unwrap().as_deref(), Some("pässwörd"));
        delete(&dir, "a").unwrap();
        assert_eq!(get(&dir, "a", || panic!("no legacy lookup")).unwrap(), None);
        // Stored encrypted, not as plain text.
        let raw = fs::read(dir.join(DATA_FILE)).unwrap();
        assert!(!raw.windows(7).any(|w| w == b"hunter2"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_is_migrated_once() {
        let dir = temp_dir();
        assert_eq!(get(&dir, "x", || Some("old".into())).unwrap().as_deref(), Some("old"));
        assert_eq!(get(&dir, "x", || panic!("asked twice")).unwrap().as_deref(), Some("old"));
        assert_eq!(get(&dir, "y", || None).unwrap(), None);
        assert_eq!(get(&dir, "y", || panic!("asked twice")).unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_file_is_set_aside() {
        let dir = temp_dir();
        set(&dir, "a", "secret").unwrap();
        fs::write(dir.join(KEY_FILE), [7u8; 32]).unwrap();
        assert_eq!(get(&dir, "a", || None).unwrap(), None);
        assert!(dir.join("credentials.unreadable").exists());
        set(&dir, "a", "new").unwrap();
        assert_eq!(get(&dir, "a", || None).unwrap().as_deref(), Some("new"));
        let _ = fs::remove_dir_all(&dir);
    }
}
