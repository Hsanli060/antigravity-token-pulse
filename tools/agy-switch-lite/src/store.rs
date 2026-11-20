use crate::dpapi;
use crate::models::{now_unix, Account, AccountIndex, AccountSummary, QuotaData, TokenData};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const DATA_DIR_NAME: &str = ".antigravity_tools";
const ACCOUNTS_INDEX: &str = "accounts.json";
const ACCOUNTS_DIR: &str = "accounts";
const IDENTITY_CACHE_FILE: &str = "live-identity-cache.json";
const OAUTH_CLIENT_CACHE_FILE: &str = "oauth-client.json";

pub fn home_dir() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("USERPROFILE").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    if let Some(p) = std::env::var_os("HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    Err("Cannot resolve home directory".to_string())
}

pub fn data_dir() -> Result<PathBuf, String> {
    if let Some(env_dir) = std::env::var_os("ABV_DATA_DIR").filter(|s| !s.to_string_lossy().trim().is_empty()) {
        let p = PathBuf::from(env_dir);
        fs::create_dir_all(&p).map_err(|e| format!("Failed to create data dir: {e}"))?;
        return Ok(p);
    }
    let dir = home_dir()?.join(DATA_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    Ok(dir)
}

pub fn accounts_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join(ACCOUNTS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create accounts dir: {e}"))?;
    Ok(dir)
}

pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent dir: {e}"))?;
    }
    let tmp = path.with_extension(format!("tmp.{}.{}", std::process::id(), Uuid::new_v4()));
    fs::write(&tmp, data).map_err(|e| format!("Failed to write temp file: {e}"))?;
    let mut renamed = false;
    for delay_ms in [0u64, 15, 35, 70] {
        if delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        if fs::rename(&tmp, path).is_ok() {
            renamed = true;
            break;
        }
    }
    if !renamed {
        let res = fs::write(path, data).map_err(|e| format!("Failed to save file: {e}"));
        let _ = fs::remove_file(&tmp);
        return res;
    }
    Ok(())
}

pub struct SwitchLock {
    _file: File,
}

impl SwitchLock {
    pub fn acquire(root: &Path) -> Result<Self, String> {
        let lock_path = root.join("account-switch.lock");
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        loop {
            let mut opts = OpenOptions::new();
            opts.read(true).write(true).create(true).truncate(false);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                opts.share_mode(0);
            }
            match opts.open(&lock_path) {
                Ok(file) => return Ok(Self { _file: file }),
                Err(e) => {
                    #[cfg(windows)]
                    let is_busy = e.raw_os_error() == Some(32);
                    #[cfg(not(windows))]
                    let is_busy = false;
                    if is_busy && std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        continue;
                    }
                    if is_busy {
                        return Err("another_account_switch_in_progress".to_string());
                    }
                    return Err(format!("Cannot acquire account-switch lock: {e}"));
                }
            }
        }
    }
}

fn sanitize_json_bytes(raw: &[u8]) -> String {
    let no_bom = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &raw[3..]
    } else {
        raw
    };
    let no_nul: Vec<u8> = no_bom.iter().skip_while(|&&b| b == 0).copied().collect();
    String::from_utf8_lossy(&no_nul).into_owned()
}

pub fn load_index(root: &Path) -> Result<AccountIndex, String> {
    let idx_path = root.join(ACCOUNTS_INDEX);
    if !idx_path.exists() {
        return Ok(AccountIndex::new());
    }
    let raw = fs::read(&idx_path).map_err(|e| format!("Cannot read accounts.json: {e}"))?;
    if raw.is_empty() {
        return Ok(AccountIndex::new());
    }
    let text = sanitize_json_bytes(&raw);
    if text.trim().is_empty() {
        return Ok(AccountIndex::new());
    }
    serde_json::from_str::<AccountIndex>(&text).map_err(|e| format!("Invalid accounts.json: {e}"))
}

pub fn save_index(root: &Path, index: &AccountIndex) -> Result<(), String> {
    let content =
        serde_json::to_string_pretty(index).map_err(|e| format!("Serialize index failed: {e}"))?;
    write_atomic(&root.join(ACCOUNTS_INDEX), content.as_bytes())
}

fn unprotect_account_tokens(acc: &mut Account) -> Result<bool, String> {
    let mut needs_migration = false;
    let (at, at_prot) = dpapi::unprotect_string(&acc.token.access_token)?;
    if !at.is_empty() && !at_prot {
        needs_migration = true;
    }
    acc.token.access_token = at;

    let (rt, rt_prot) = dpapi::unprotect_string(&acc.token.refresh_token)?;
    if !rt.is_empty() && !rt_prot {
        needs_migration = true;
    }
    acc.token.refresh_token = rt;

    if let Some(raw_id) = acc.token.id_token.as_deref() {
        let (id_plain, id_prot) = dpapi::unprotect_string(raw_id)?;
        if !id_plain.is_empty() && !id_prot {
            needs_migration = true;
        }
        acc.token.id_token = if id_plain.is_empty() {
            None
        } else {
            Some(id_plain)
        };
    }
    Ok(needs_migration)
}

fn protect_account_clone(account: &Account) -> Result<Account, String> {
    let mut protected = account.clone();
    protected.token.access_token = dpapi::protect_string(&account.token.access_token)?;
    protected.token.refresh_token = dpapi::protect_string(&account.token.refresh_token)?;
    if let Some(ref id_tok) = account.token.id_token {
        protected.token.id_token = Some(dpapi::protect_string(id_tok)?);
    }
    Ok(protected)
}

pub fn load_account(root: &Path, id: &str) -> Result<Account, String> {
    let path = accounts_dir(root)?.join(format!("{id}.json"));
    let raw = fs::read(&path).map_err(|e| format!("Cannot read account {id}: {e}"))?;
    let text = sanitize_json_bytes(&raw);
    let (mut acc, recovered_json) = match serde_json::from_str::<Account>(&text) {
        Ok(acc) => (acc, false),
        Err(e) => {
            let mut de = serde_json::Deserializer::from_str(&text);
            if let Ok(acc) = serde::Deserialize::deserialize(&mut de) {
                (acc, true)
            } else {
                return Err(format!("Invalid account JSON {id}: {e}"));
            }
        }
    };
    let needs_dpapi_migration = unprotect_account_tokens(&mut acc)?;
    if recovered_json || (cfg!(windows) && needs_dpapi_migration) {
        let _ = save_account(root, &acc);
    }
    Ok(acc)
}

pub fn save_account(root: &Path, account: &Account) -> Result<(), String> {
    let path = accounts_dir(root)?.join(format!("{}.json", account.id));
    let protected = protect_account_clone(account)?;
    let content = serde_json::to_string_pretty(&protected)
        .map_err(|e| format!("Serialize account failed: {e}"))?;
    write_atomic(&path, content.as_bytes())
}

pub fn list_accounts(root: &Path) -> Result<(AccountIndex, Vec<Account>), String> {
    let index = load_index(root)?;
    let mut accounts = Vec::new();
    for summary in &index.accounts {
        if let Ok(acc) = load_account(root, &summary.id) {
            accounts.push(acc);
        }
    }
    Ok((index, accounts))
}

pub fn upsert_account(
    root: &Path,
    email: String,
    name: Option<String>,
    token: TokenData,
    quota: Option<QuotaData>,
    mark_current: bool,
) -> Result<(Account, bool), String> {
    let mut index = load_index(root)?;
    let existing_id = index
        .accounts
        .iter()
        .find(|s| s.email.eq_ignore_ascii_case(&email))
        .map(|s| s.id.clone());

    if let Some(id) = existing_id {
        let mut acc = load_account(root, &id).unwrap_or_else(|_| Account::new(id.clone(), email.clone(), token.clone()));
        let token_changed = acc.token.refresh_token != token.refresh_token
            || acc.token.access_token != token.access_token;
        acc.token = token;
        if name.is_some() {
            acc.name = name.clone();
        }
        if acc.disabled && token_changed {
            acc.disabled = false;
            acc.disabled_reason = None;
            acc.disabled_at = None;
        }
        if let Some(q) = quota {
            acc.quota = Some(q);
        }
        acc.last_used = now_unix();
        save_account(root, &acc)?;
        if let Some(s) = index.accounts.iter_mut().find(|s| s.id == id) {
            if acc.name.is_some() {
                s.name = acc.name.clone();
            }
            s.disabled = acc.disabled;
            s.last_used = acc.last_used;
        }
        if mark_current || index.current_account_id.is_none() {
            index.current_account_id = Some(id);
            index.current_target_ide = Some("app".to_string());
        }
        save_index(root, &index)?;
        return Ok((acc, false));
    }

    let id = Uuid::new_v4().to_string();
    let mut acc = Account::new(id.clone(), email.clone(), token);
    acc.name = name.clone();
    acc.quota = quota;
    save_account(root, &acc)?;

    index.accounts.push(AccountSummary {
        id: acc.id.clone(),
        email: acc.email.clone(),
        name: acc.name.clone(),
        disabled: acc.disabled,
        protected_models: acc.protected_models.clone(),
        created_at: acc.created_at,
        last_used: acc.last_used,
    });
    if mark_current || index.current_account_id.is_none() {
        index.current_account_id = Some(id);
        index.current_target_ide = Some("app".to_string());
    }
    save_index(root, &index)?;
    Ok((acc, true))
}

pub fn delete_account(root: &Path, selector: &str) -> Result<String, String> {
    let _lock = SwitchLock::acquire(root)?;
    let mut index = load_index(root)?;
    let target_id = index
        .accounts
        .iter()
        .find(|s| s.id == selector || s.email.eq_ignore_ascii_case(selector))
        .map(|s| s.id.clone())
        .ok_or_else(|| format!("Account not found: {selector}"))?;

    index.accounts.retain(|s| s.id != target_id);
    if index.current_ide_account_id.as_deref() == Some(target_id.as_str()) {
        index.current_ide_account_id = None;
    }
    if index.current_vscode_account_id.as_deref() == Some(target_id.as_str()) {
        index.current_vscode_account_id = None;
    }
    if index.current_account_id.as_deref() == Some(target_id.as_str()) {
        index.current_account_id = index.accounts.first().map(|s| s.id.clone());
    }
    save_index(root, &index)?;

    let file_path = accounts_dir(root)?.join(format!("{target_id}.json"));
    if file_path.exists() {
        let _ = fs::remove_file(&file_path);
    }
    Ok(target_id)
}

pub fn set_current_account_id(root: &Path, id: &str) -> Result<bool, String> {
    let mut index = load_index(root)?;
    if !index.accounts.iter().any(|s| s.id == id) {
        return Err(format!("Account not found: {id}"));
    }
    let changed = index.current_account_id.as_deref() != Some(id);
    if changed {
        index.current_account_id = Some(id.to_string());
        index.current_target_ide = Some("app".to_string());
        save_index(root, &index)?;
    }
    Ok(changed)
}

pub fn load_identity_cache(root: &Path) -> HashMap<String, String> {
    let path = root.join(IDENTITY_CACHE_FILE);
    let Ok(raw) = fs::read(&path) else {
        return HashMap::new();
    };
    let text = sanitize_json_bytes(&raw);
    serde_json::from_str::<HashMap<String, String>>(&text).unwrap_or_default()
}

pub fn save_identity_cache_entry(root: &Path, rt_hash: &str, email: &str) {
    let mut map = load_identity_cache(root);
    if map.get(rt_hash).is_some_and(|e| e.eq_ignore_ascii_case(email)) {
        return;
    }
    if map.len() > 64 {
        map.clear();
    }
    map.insert(rt_hash.to_string(), email.to_string());
    if let Ok(text) = serde_json::to_string_pretty(&map) {
        let _ = write_atomic(&root.join(IDENTITY_CACHE_FILE), text.as_bytes());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OAuthClientCacheFile {
    client_id: String,
    client_secret: String,
}

pub fn load_oauth_client_cache(root: &Path) -> Option<(String, String)> {
    let path = root.join(OAUTH_CLIENT_CACHE_FILE);
    let raw = fs::read(&path).ok()?;
    let text = sanitize_json_bytes(&raw);
    let parsed = serde_json::from_str::<OAuthClientCacheFile>(&text).ok()?;
    let (id_plain, id_prot) = dpapi::unprotect_string(&parsed.client_id).ok()?;
    let (sec_plain, sec_prot) = dpapi::unprotect_string(&parsed.client_secret).ok()?;
    let id = id_plain.trim().to_string();
    let sec = sec_plain.trim().to_string();
    if id.is_empty() || sec.is_empty() {
        return None;
    }
    if cfg!(windows) && (!id_prot || !sec_prot) {
        let _ = save_oauth_client_cache(root, &id, &sec);
    }
    Some((id, sec))
}

pub fn save_oauth_client_cache(root: &Path, client_id: &str, client_secret: &str) -> Result<(), String> {
    let entry = OAuthClientCacheFile {
        client_id: dpapi::protect_string(client_id.trim())?,
        client_secret: dpapi::protect_string(client_secret.trim())?,
    };
    let text = serde_json::to_string_pretty(&entry)
        .map_err(|e| format!("Serialize oauth client cache failed: {e}"))?;
    write_atomic(&root.join(OAUTH_CLIENT_CACHE_FILE), text.as_bytes())
}
