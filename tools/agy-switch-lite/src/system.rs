use crate::models::{format_rfc3339_utc, Account, TokenData};
use crate::protobuf;
use crate::store::{home_dir, write_atomic};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct LiveCredential {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct KeyringTokenDetails {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    token_type: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expiry: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct KeyringPayload {
    token: KeyringTokenDetails,
    #[serde(default)]
    auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id_token: Option<String>,
}

fn parse_keyring_json(raw: &str) -> Option<LiveCredential> {
    let trimmed = raw.trim().trim_start_matches('\u{feff}');
    if trimmed.is_empty() {
        return None;
    }
    let parsed: KeyringPayload = serde_json::from_str(trimmed).ok()?;
    let rt = parsed.token.refresh_token.trim().to_string();
    if rt.is_empty() {
        return None;
    }
    Some(LiveCredential {
        access_token: parsed.token.access_token.trim().to_string(),
        refresh_token: rt,
        id_token: parsed.id_token.filter(|s| !s.trim().is_empty()),
    })
}

pub fn decode_jwt_email(id_token: &str) -> Option<String> {
    let part = id_token.split('.').nth(1)?;
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(part)
        .or_else(|_| general_purpose::URL_SAFE.decode(part))
        .ok()?;
    let val: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    val.get("email")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| s.contains('@'))
}

pub fn format_keyring_payload(token: &TokenData) -> Result<String, String> {
    let payload = KeyringPayload {
        token: KeyringTokenDetails {
            access_token: token.access_token.clone(),
            token_type: "Bearer".to_string(),
            refresh_token: token.refresh_token.clone(),
            expiry: format_rfc3339_utc(token.expiry_timestamp),
        },
        auth_method: "consumer".to_string(),
        id_token: token.id_token.clone(),
    };
    serde_json::to_string(&payload).map_err(|e| format!("Serialize credential payload failed: {e}"))
}

#[cfg(windows)]
pub fn read_system_keyring() -> Option<LiveCredential> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target: Vec<u16> = OsStr::new("gemini:antigravity")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut ptr) };
    if ok == 0 || ptr.is_null() {
        return None;
    }
    let result = unsafe {
        let cred = &*ptr;
        if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0 {
            None
        } else {
            let slice =
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
            std::str::from_utf8(slice).ok().and_then(parse_keyring_json)
        }
    };
    unsafe { CredFree(ptr as *const _) };
    result
}

#[cfg(not(windows))]
pub fn read_system_keyring() -> Option<LiveCredential> {
    None
}

pub fn cli_session_path() -> Option<PathBuf> {
    let home = home_dir().ok()?;
    let dir = home.join(".gemini").join("antigravity-cli");
    if dir.is_dir() {
        Some(dir.join("antigravity-oauth-token"))
    } else {
        None
    }
}

pub fn read_live_credentials() -> Option<LiveCredential> {
    if let Some(c) = read_system_keyring() {
        return Some(c);
    }
    if let Some(p) = cli_session_path() {
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Some(c) = parse_keyring_json(&raw) {
                return Some(c);
            }
        }
    }
    None
}

#[cfg(windows)]
fn write_windows_keyring(payload_json: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let target: Vec<u16> = OsStr::new("gemini:antigravity")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let user: Vec<u16> = OsStr::new("antigravity")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let bytes = payload_json.as_bytes();
    let cred = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_ptr() as *mut u16,
        Comment: std::ptr::null_mut(),
        LastWritten: FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        },
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: user.as_ptr() as *mut u16,
    };
    unsafe {
        let _ = CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0);
        if CredWriteW(&cred, 0) == 0 {
            return Err(format!(
                "CredWriteW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

fn candidate_vscdb_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").filter(|s| !s.is_empty()) {
        let p = PathBuf::from(appdata)
            .join("Antigravity")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb");
        if p.is_file() {
            out.push(p);
        }
    }
    out
}

fn inject_vscdb(db_path: &Path, account: &Account) -> Result<(), String> {
    let backup = db_path.with_extension("vscdb.backup");
    let _ = fs::copy(db_path, &backup);
    let conn = Connection::open(db_path).map_err(|e| format!("Cannot open state.vscdb: {e}"))?;

    let mut is_gcp_tos = account.token.is_gcp_tos;
    if account.token.oauth_client_key.as_deref() == Some("antigravity_enterprise") {
        is_gcp_tos = false;
    }
    let oauth_info = protobuf::create_oauth_info(
        &account.token.access_token,
        &account.token.refresh_token,
        account.token.expiry_timestamp,
        is_gcp_tos,
        account.token.id_token.as_deref(),
        Some(&account.email),
    );

    let current_topic = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?",
            ["antigravityUnifiedStateSync.oauthToken"],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Read oauthToken failed: {e}"))?
        .and_then(|v| general_purpose::STANDARD.decode(v).ok())
        .unwrap_or_default();

    let mut topic = protobuf::remove_unified_topic_entry(&current_topic, "oauthTokenInfoSentinelKey")?;
    topic.extend(protobuf::create_unified_topic_entry(
        "oauthTokenInfoSentinelKey",
        &oauth_info,
    ));
    let topic_b64 = general_purpose::STANDARD.encode(&topic);

    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ["antigravityUnifiedStateSync.oauthToken", &topic_b64],
    )
    .map_err(|e| format!("Write oauthToken failed: {e}"))?;

    let user_status = protobuf::create_unified_state_entry(
        "userStatusSentinelKey",
        &protobuf::create_minimal_user_status_payload(&account.email),
    );
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ["antigravityUnifiedStateSync.userStatus", &user_status],
    )
    .map_err(|e| format!("Write userStatus failed: {e}"))?;

    if let Some(pid) = account
        .token
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let pref = protobuf::create_unified_state_entry(
            "enterpriseGcpProjectId",
            &protobuf::create_string_value_payload(pid),
        );
        let _ = conn.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
            ["antigravityUnifiedStateSync.enterprisePreferences", &pref],
        );
    } else {
        let _ = conn.execute(
            "DELETE FROM ItemTable WHERE key = ?",
            ["antigravityUnifiedStateSync.enterprisePreferences"],
        );
    }

    let _ = conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ["antigravityOnboarding", "true"],
    );
    let _ = conn.execute(
        "DELETE FROM ItemTable WHERE key = ?",
        ["jetskiStateSync.agentManagerInitState"],
    );
    Ok(())
}

pub fn recover_zero_filled_pbtxt() {
    let Ok(home) = home_dir() else { return };
    let path = home
        .join(".gemini")
        .join("antigravity")
        .join("antigravity_state.pbtxt");
    if let Ok(bytes) = fs::read(&path) {
        if !bytes.is_empty() && bytes.iter().all(|&b| b == 0) {
            let _ = fs::remove_file(&path);
        }
    }
}

pub fn write_credentials(account: &Account, sync_vscdb: bool) -> Result<(), String> {
    let payload_json = format_keyring_payload(&account.token)?;
    #[cfg(windows)]
    write_windows_keyring(&payload_json)?;

    if let Some(cli_path) = cli_session_path() {
        write_atomic(&cli_path, payload_json.as_bytes())?;
    }
    if sync_vscdb {
        for db_path in candidate_vscdb_paths() {
            let _ = inject_vscdb(&db_path, account);
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn find_running_antigravity() -> (Vec<u32>, Option<PathBuf>) {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let mut pids = Vec::new();
    let mut exe_path: Option<PathBuf> = None;
    let self_pid = std::process::id();

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return (pids, exe_path);
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case("Antigravity.exe") && entry.th32ProcessID != self_pid {
                    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                    let mut full_path = String::new();
                    if !h.is_null() {
                        let mut buf = [0u16; 1024];
                        let mut sz = buf.len() as u32;
                        if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut sz) != 0 {
                            full_path = String::from_utf16_lossy(&buf[..sz as usize]);
                        }
                        CloseHandle(h);
                    }
                    let lower = full_path.to_ascii_lowercase();
                    if !lower.contains("agy-switch") {
                        pids.push(entry.th32ProcessID);
                        if exe_path.is_none() && !full_path.is_empty() {
                            exe_path = Some(PathBuf::from(full_path));
                        }
                    }
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    (pids, exe_path)
}

#[cfg(not(windows))]
pub fn find_running_antigravity() -> (Vec<u32>, Option<PathBuf>) {
    (Vec::new(), None)
}

pub fn find_antigravity_exe() -> Option<PathBuf> {
    let (_, running) = find_running_antigravity();
    if running.is_some() {
        return running;
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            for rel in [
                "Programs\\antigravity\\Antigravity.exe",
                "Programs\\Antigravity\\Antigravity.exe",
                "antigravity\\Antigravity.exe",
            ] {
                let cand = base.join(rel);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            let cand = PathBuf::from(pf).join("Antigravity").join("Antigravity.exe");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

#[cfg(windows)]
pub fn close_antigravity_gracefully() -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
    };

    let (initial_pids, _) = find_running_antigravity();
    if initial_pids.is_empty() {
        return Ok(());
    }

    unsafe extern "system" fn enum_close_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let pids = &*(lparam as *const Vec<u32>);
        let mut wpid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut wpid);
        if pids.contains(&wpid) {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        1
    }

    struct VisibleCheck<'a> {
        pids: &'a [u32],
        any_visible: bool,
    }

    unsafe extern "system" fn enum_visible_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let state = &mut *(lparam as *mut VisibleCheck<'_>);
        if IsWindowVisible(hwnd) != 0 {
            let mut wpid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut wpid);
            if state.pids.contains(&wpid) {
                state.any_visible = true;
                return 0;
            }
        }
        1
    }

    let has_visible_window = |pids: &[u32]| -> bool {
        let mut state = VisibleCheck {
            pids,
            any_visible: false,
        };
        unsafe {
            EnumWindows(
                Some(enum_visible_proc),
                &mut state as *mut VisibleCheck<'_> as LPARAM,
            );
        }
        state.any_visible
    };

    unsafe {
        EnumWindows(
            Some(enum_close_proc),
            &initial_pids as *const Vec<u32> as LPARAM,
        );
    }

    // Give Electron a short graceful flush window (up to 1.8s), exiting early once visible windows
    // disappear (e.g. minimized to tray) after a brief 350ms flush grace period.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1800);
    let mut ui_closed_at: Option<std::time::Instant> = None;
    while std::time::Instant::now() < deadline {
        let (pids_now, _) = find_running_antigravity();
        if pids_now.is_empty() {
            return Ok(());
        }
        if !has_visible_window(&pids_now) {
            let first = *ui_closed_at.get_or_insert_with(std::time::Instant::now);
            if first.elapsed() >= std::time::Duration::from_millis(350) {
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(80));
    }

    let (remaining, _) = find_running_antigravity();
    for pid in remaining {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !h.is_null() {
                TerminateProcess(h, 0);
                CloseHandle(h);
            }
        }
    }

    let force_deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < force_deadline {
        if find_running_antigravity().0.is_empty() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn close_antigravity_gracefully() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn is_in_kill_on_close_job() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn QueryInformationJobObject(
            h_job: *mut std::ffi::c_void,
            info_class: i32,
            info: *mut u8,
            info_len: u32,
            ret_len: *mut u32,
        ) -> i32;
    }
    let mut buf = [0u8; 256];
    let mut ret_len = 0u32;
    let ok = unsafe {
        QueryInformationJobObject(
            std::ptr::null_mut(),
            9, // JobObjectExtendedLimitInformation
            buf.as_mut_ptr(),
            144,
            &mut ret_len,
        )
    };
    if ok == 0 {
        return false;
    }
    let flags = u32::from_ne_bytes([buf[16], buf[17], buf[18], buf[19]]);
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    (flags & 0x2000) != 0
}

#[cfg(not(windows))]
pub fn is_in_kill_on_close_job() -> bool {
    false
}

#[cfg(windows)]
pub fn respawn_switch_outside_job(selector: &str, target: &str) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let self_exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let exe_str = self_exe.to_string_lossy().replace('\'', "''");
    let sel_str = selector.replace('\'', "''").replace('"', "");
    let tgt_str = target.replace('\'', "''").replace('"', "");

    let ps_script = format!(
        "$cmd = '\"{exe}\" switch \"{sel}\" --target \"{tgt}\" --worker --json'; \
         $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{{ ShowWindow = [uint16]0 }}; \
         $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine = $cmd; ProcessStartupInformation = $si }}; \
         if ($r.ReturnValue -ne 0) {{ exit 1 }}",
        exe = exe_str,
        sel = sel_str,
        tgt = tgt_str
    );

    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let ps_exe = PathBuf::from(sys_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let ps_cmd = if ps_exe.is_file() {
        ps_exe
    } else {
        PathBuf::from("powershell.exe")
    };

    let status = std::process::Command::new(ps_cmd)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps_script,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Failed to invoke WMI breakaway: {e}"))?;

    Ok(status.success())
}

#[cfg(not(windows))]
pub fn respawn_switch_outside_job(_selector: &str, _target: &str) -> Result<bool, String> {
    Ok(false)
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn shell_execute_open(exe_path: &Path) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let op = to_wide("open");
    let file = to_wide(&exe_path.to_string_lossy());
    let dir_wide = exe_path
        .parent()
        .map(|p| to_wide(&p.to_string_lossy()))
        .unwrap_or_else(|| to_wide(""));
    let dir_ptr = if dir_wide.len() > 1 {
        dir_wide.as_ptr()
    } else {
        std::ptr::null()
    };
    let rc = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            dir_ptr,
            SW_SHOWNORMAL,
        )
    } as isize;
    if rc <= 32 {
        return Err(format!("Failed to relaunch Antigravity (ShellExecuteW rc={rc})"));
    }
    Ok(())
}

pub fn start_antigravity_detached(exe_path: &Path) -> Result<(), String> {
    std::thread::sleep(std::time::Duration::from_millis(120));

    let mut cmd = std::process::Command::new(exe_path);
    if let Some(parent) = exe_path.parent() {
        if parent.is_dir() {
            cmd.current_dir(parent);
        }
    }
    for k in [
        "ELECTRON_RUN_AS_NODE",
        "ELECTRON_NO_ATTACH_CONSOLE",
        "VSCODE_IPC_HOOK",
        "VSCODE_NLS_CONFIG",
        "VSCODE_PID",
        "CHROME_CRASHPAD_PIPE_NAME",
    ] {
        cmd.env_remove(k);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    let spawned_ok = cmd.spawn().is_ok();
    #[cfg(windows)]
    {
        if !spawned_ok {
            shell_execute_open(exe_path)?;
        }
        // Verify Antigravity.exe process appeared within 1.0s; if not, fallback to ShellExecuteW
        let check_deadline = std::time::Instant::now() + std::time::Duration::from_millis(1000);
        let mut seen = false;
        while std::time::Instant::now() < check_deadline {
            if !find_running_antigravity().0.is_empty() {
                seen = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if !seen && spawned_ok {
            let _ = shell_execute_open(exe_path);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if !spawned_ok {
            return Err("Failed to relaunch Antigravity".to_string());
        }
        Ok(())
    }
}
