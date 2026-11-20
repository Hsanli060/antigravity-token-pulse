use crate::models::{now_unix, TokenData};
use crate::store;
use crate::system;
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;
use uuid::Uuid;

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_REFRESH_SKEW_SECONDS: i64 = 900;

static OAUTH_CLIENT_MEM: OnceLock<(String, String)> = OnceLock::new();

fn decode_jwt_aud(id_token: &str) -> Option<String> {
    let payload_b64 = id_token.split('.').nth(1)?;
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .or_else(|_| general_purpose::URL_SAFE.decode(payload_b64))
        .ok()?;
    let val: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    val.get("aud")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn candidate_host_binaries() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(exe) = system::find_antigravity_exe() {
        if let Some(dir) = exe.parent() {
            let ls = dir.join("resources").join("bin").join("language_server.exe");
            if ls.is_file() {
                out.push(ls);
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            for rel in [
                "Programs\\Antigravity\\resources\\bin\\language_server.exe",
                "Programs\\antigravity\\resources\\bin\\language_server.exe",
                "agy\\bin\\agy.exe",
                "agy\\bin\\agy.EXE",
            ] {
                let p = base.join(rel);
                if p.is_file() && !out.iter().any(|x| x == &p) {
                    out.push(p);
                }
            }
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            let p = PathBuf::from(pf)
                .join("Antigravity")
                .join("resources")
                .join("bin")
                .join("language_server.exe");
            if p.is_file() && !out.iter().any(|x| x == &p) {
                out.push(p);
            }
        }
    }
    out
}

fn is_valid_client_id_prefix(bytes: &[u8]) -> Option<usize> {
    // Match "<10..14 digits>-<20..40 lowercase alnum>" right before the Google OAuth client ID domain suffix
    let len = bytes.len();
    let mut dash_pos = None;
    let mut i = len;
    while i > 0 {
        i -= 1;
        let b = bytes[i];
        if b == b'-' {
            dash_pos = Some(i);
            break;
        }
        if !(b.is_ascii_lowercase() || b.is_ascii_digit()) {
            return None;
        }
    }
    let dash = dash_pos?;
    let suffix_len = len - dash - 1;
    if !(20..=40).contains(&suffix_len) {
        return None;
    }
    let mut start = dash;
    while start > 0 && bytes[start - 1].is_ascii_digit() && (dash - start) < 15 {
        start -= 1;
    }
    let digits_len = dash - start;
    if !(10..=14).contains(&digits_len) {
        return None;
    }
    Some(start)
}

fn extract_oauth_candidates_from_binary(path: &Path) -> (Vec<String>, Vec<String>) {
    let Ok(buf) = std::fs::read(path) else {
        return (Vec::new(), Vec::new());
    };
    let id_suffix = [".apps.", "googleusercontent.com"].concat();
    let id_suffix_bytes = id_suffix.as_bytes();
    let sec_prefix = ["GOC", "SPX-"].concat();
    let sec_prefix_bytes = sec_prefix.as_bytes();

    let mut ids = Vec::new();
    let mut pos = 0usize;
    while pos + id_suffix_bytes.len() <= buf.len() {
        if let Some(rel) = buf[pos..]
            .windows(id_suffix_bytes.len())
            .position(|w| w == id_suffix_bytes)
        {
            let hit = pos + rel;
            let win_start = hit.saturating_sub(60);
            if let Some(rel_start) = is_valid_client_id_prefix(&buf[win_start..hit]) {
                let abs_start = win_start + rel_start;
                if let Ok(s) = std::str::from_utf8(&buf[abs_start..hit + id_suffix_bytes.len()]) {
                    let cand = s.to_string();
                    if !ids.contains(&cand) {
                        ids.push(cand);
                    }
                }
            }
            pos = hit + id_suffix_bytes.len();
        } else {
            break;
        }
    }

    let mut secs = Vec::new();
    pos = 0;
    while pos + 35 <= buf.len() {
        if let Some(rel) = buf[pos..]
            .windows(sec_prefix_bytes.len())
            .position(|w| w == sec_prefix_bytes)
        {
            let hit = pos + rel;
            if hit + 35 <= buf.len() {
                let tail = &buf[hit + sec_prefix_bytes.len()..hit + 35];
                if tail
                    .iter()
                    .all(|&b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    if let Ok(s) = std::str::from_utf8(&buf[hit..hit + 35]) {
                        let cand = s.to_string();
                        if !secs.contains(&cand) {
                            secs.push(cand);
                        }
                    }
                }
            }
            pos = hit + sec_prefix_bytes.len();
        } else {
            break;
        }
    }
    (ids, secs)
}

async fn verify_client_pair(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    hint_refresh_token: Option<&str>,
) -> bool {
    let rt = hint_refresh_token
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("agy_switch_client_probe");
    let params = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("refresh_token", rt),
        ("grant_type", "refresh_token"),
    ];
    let Ok(resp) = client
        .post(TOKEN_URL)
        .header(reqwest::header::USER_AGENT, hub_user_agent())
        .form(&params)
        .send()
        .await
    else {
        return false;
    };
    if resp.status().is_success() {
        return true;
    }
    let body = resp.text().await.unwrap_or_default();
    if hint_refresh_token.is_some() {
        // When verifying against a real refresh token, unauthorized_client or invalid_client means wrong pair.
        !body.contains("invalid_client") && !body.contains("unauthorized_client")
    } else {
        // Against a dummy refresh token, Google returns invalid_grant ONLY when (client_id, client_secret) is valid!
        body.contains("invalid_grant") && !body.contains("invalid_client")
    }
}

pub async fn resolve_oauth_client(
    root: &Path,
    hint_id_token: Option<&str>,
    hint_refresh_token: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(pair) = OAUTH_CLIENT_MEM.get() {
        return Ok(pair.clone());
    }
    // 1. Explicit environment variable override
    if let (Ok(env_id), Ok(env_sec)) = (
        std::env::var("AGY_SWITCH_OAUTH_CLIENT_ID"),
        std::env::var("AGY_SWITCH_OAUTH_CLIENT_SECRET"),
    ) {
        let id = env_id.trim().to_string();
        let sec = env_sec.trim().to_string();
        if !id.is_empty() && !sec.is_empty() {
            let _ = OAUTH_CLIENT_MEM.set((id.clone(), sec.clone()));
            return Ok((id, sec));
        }
    }
    // 2. DPAPI-encrypted local cache (~/.antigravity_tools/oauth-client.json)
    if let Some((id, sec)) = store::load_oauth_client_cache(root) {
        let _ = OAUTH_CLIENT_MEM.set((id.clone(), sec.clone()));
        return Ok((id, sec));
    }

    // 3. Auto-discover from local official Antigravity / agy installation
    let mut ids = Vec::new();
    let mut secs = Vec::new();
    for bin in candidate_host_binaries() {
        let (found_ids, found_secs) = extract_oauth_candidates_from_binary(&bin);
        if !found_ids.is_empty() && !found_secs.is_empty() {
            ids = found_ids;
            secs = found_secs;
            break;
        }
    }
    if ids.is_empty() || secs.is_empty() {
        return Err(
            "未检测到本机 OAuth 客户端配置：请确认已安装 Antigravity 2.0，或配置 AGY_SWITCH_OAUTH_CLIENT_ID / AGY_SWITCH_OAUTH_CLIENT_SECRET"
                .to_string(),
        );
    }

    // Gather optional live token hints to pinpoint the exact consumer client pair
    let live_cred = system::read_live_credentials();
    let effective_id_tok = hint_id_token
        .map(str::to_string)
        .or_else(|| live_cred.as_ref().and_then(|c| c.id_token.clone()));
    let effective_rt = hint_refresh_token
        .map(str::to_string)
        .or_else(|| live_cred.as_ref().map(|c| c.refresh_token.clone()));
    let aud_hint = effective_id_tok.as_deref().and_then(decode_jwt_aud);

    // Order candidate IDs: aud match first, then index 1 (standard consumer desktop client), then rest
    let mut ordered_id_indices: Vec<usize> = Vec::new();
    if let Some(ref aud) = aud_hint {
        if let Some(pos) = ids.iter().position(|x| x == aud) {
            ordered_id_indices.push(pos);
        }
    }
    if ids.len() >= 2 && !ordered_id_indices.contains(&1) {
        ordered_id_indices.push(1);
    }
    for i in 0..ids.len() {
        if !ordered_id_indices.contains(&i) {
            ordered_id_indices.push(i);
        }
    }

    // Build prioritized (id, secret) probe list: aligned indices first, then cross pairs
    let mut pairs: Vec<(String, String)> = Vec::new();
    for &i in &ordered_id_indices {
        if i < secs.len() {
            pairs.push((ids[i].clone(), secs[i].clone()));
        }
    }
    for &i in &ordered_id_indices {
        for j in 0..secs.len() {
            if i != j {
                pairs.push((ids[i].clone(), secs[j].clone()));
            }
        }
    }

    let client = build_http_client(15)?;
    for (cand_id, cand_sec) in &pairs {
        if verify_client_pair(&client, cand_id, cand_sec, effective_rt.as_deref()).await {
            let _ = store::save_oauth_client_cache(root, cand_id, cand_sec);
            let _ = OAUTH_CLIENT_MEM.set((cand_id.clone(), cand_sec.clone()));
            return Ok((cand_id.clone(), cand_sec.clone()));
        }
    }

    // Fallback: if offline during probe, use top prioritized pair without caching until verified
    if let Some((cand_id, cand_sec)) = pairs.into_iter().next() {
        return Ok((cand_id, cand_sec));
    }

    Err("无法从本机 Antigravity 安装目录定位有效的 OAuth 客户端配置".to_string())
}

pub fn hub_user_agent() -> String {
    let os_type = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    };
    format!("antigravity/hub/4.3.0 (os_type={os_type}; arch={arch})")
}

static SHARED_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn build_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .pool_max_idle_per_host(8)
        .build()
        .map_err(|e| format!("Cannot build HTTP client: {e}"))
}

pub fn shared_http_client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = SHARED_HTTP_CLIENT.get() {
        return Ok(c);
    }
    let created = build_http_client(25)?;
    let _ = SHARED_HTTP_CLIENT.set(created);
    SHARED_HTTP_CLIENT
        .get()
        .ok_or_else(|| "Failed to initialize shared HTTP client".to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_in: i64,
    #[serde(default)]
    pub token_type: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfo {
    pub email: String,
    pub name: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
}

impl UserInfo {
    pub fn display_name(&self) -> Option<String> {
        if let Some(n) = &self.name {
            if !n.trim().is_empty() {
                return Some(n.clone());
            }
        }
        match (&self.given_name, &self.family_name) {
            (Some(g), Some(f)) => Some(format!("{g} {f}")),
            (Some(g), None) => Some(g.clone()),
            (None, Some(f)) => Some(f.clone()),
            (None, None) => None,
        }
    }
}

pub fn get_auth_url(client_id: &str, redirect_uri: &str, state: &str) -> Result<String, String> {
    let scopes = [
        "openid",
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ]
    .join(" ");
    let params = [
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", scopes.as_str()),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("include_granted_scopes", "true"),
        ("state", state),
    ];
    let url = url::Url::parse_with_params(AUTH_URL, &params)
        .map_err(|e| format!("Invalid auth URL: {e}"))?;
    Ok(url.to_string())
}

pub async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let client = shared_http_client()?;
    let params = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];
    let resp = client
        .post(TOKEN_URL)
        .header(reqwest::header::USER_AGENT, hub_user_agent())
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange network error: {e}"))?;
    if resp.status().is_success() {
        resp.json::<TokenResponse>()
            .await
            .map_err(|e| format!("Token response parse error: {e}"))
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("Token exchange HTTP {status}: {body}"))
    }
}

pub async fn refresh_access_token(
    root: &Path,
    refresh_token: &str,
    hint_id_token: Option<&str>,
) -> Result<TokenResponse, String> {
    let (client_id, client_secret) =
        resolve_oauth_client(root, hint_id_token, Some(refresh_token)).await?;
    let client = shared_http_client()?;
    let params = [
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(450)).await;
        }
        let resp = client
            .post(TOKEN_URL)
            .header(reqwest::header::USER_AGENT, hub_user_agent())
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Token refresh network error: {e}"))?;
        if resp.status().is_success() {
            return resp
                .json::<TokenResponse>()
                .await
                .map_err(|e| format!("Token refresh parse error: {e}"));
        }
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if attempt == 0 && body.contains("invalid_grant") {
            continue;
        }
        return Err(format!("Token refresh HTTP {status}: {body}"));
    }
    Err("Token refresh failed".to_string())
}

pub async fn get_user_info(access_token: &str) -> Result<UserInfo, String> {
    let client = shared_http_client()?;
    let resp = client
        .get(USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("UserInfo network error: {e}"))?;
    if resp.status().is_success() {
        resp.json::<UserInfo>()
            .await
            .map_err(|e| format!("UserInfo parse error: {e}"))
    } else {
        let status = resp.status();
        Err(format!("UserInfo HTTP {status}"))
    }
}

pub async fn ensure_fresh_token(root: &Path, current: &TokenData) -> Result<TokenData, String> {
    if current.expiry_timestamp > now_unix() + TOKEN_REFRESH_SKEW_SECONDS
        && !current.access_token.trim().is_empty()
    {
        return Ok(current.clone());
    }
    let resp =
        refresh_access_token(root, &current.refresh_token, current.id_token.as_deref()).await?;
    let mut next = TokenData::new(
        resp.access_token,
        current.refresh_token.clone(),
        resp.expires_in,
        current.email.clone(),
        current.project_id.clone(),
        current.is_gcp_tos,
        resp.id_token.or_else(|| current.id_token.clone()),
    );
    next.oauth_client_key = current.oauth_client_key.clone();
    Ok(next)
}

fn oauth_success_html() -> &'static str {
    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
    <html><body style='font-family:sans-serif;text-align:center;padding:48px;'>\
    <h2 style='color:#16a34a;'>授权成功</h2>\
    <p>已同步到 Antigravity 账号面板，可关闭此页面。</p>\
    <script>setTimeout(function(){window.close();},1200);</script>\
    </body></html>"
}

fn oauth_fail_html() -> &'static str {
    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
    <html><body style='font-family:sans-serif;text-align:center;padding:48px;'>\
    <h2 style='color:#dc2626;'>授权未完成</h2>\
    <p>请返回 Antigravity 面板重试。</p>\
    </body></html>"
}

async fn read_callback(
    mut stream: TcpStream,
    expected_state: String,
) -> Option<Result<String, String>> {
    let header = tokio::time::timeout(Duration::from_secs(3), async {
        let mut data = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            let n = stream.read(&mut buf).await.ok()?;
            if n == 0 {
                return None;
            }
            data.extend_from_slice(&buf[..n]);
            if data.len() > 8192 {
                return None;
            }
            if data.windows(4).any(|w| w == b"\r\n\r\n") {
                return Some(data);
            }
        }
    })
    .await
    .ok()
    .flatten();

    let result = header.and_then(|bytes| {
        let req = std::str::from_utf8(&bytes).ok()?;
        let mut parts = req.lines().next()?.split_whitespace();
        if parts.next()? != "GET" {
            return None;
        }
        let target = parts.next()?;
        let url = url::Url::parse(&format!("http://localhost{target}")).ok()?;
        if url.path() != "/oauth-callback" || url.fragment().is_some() {
            return None;
        }
        let get_vals = |k: &str| -> Vec<String> {
            url.query_pairs()
                .filter(|(name, _)| name == k)
                .map(|(_, v)| v.into_owned())
                .collect()
        };
        let states = get_vals("state");
        if states.len() != 1 || states[0] != expected_state {
            return None;
        }
        let codes = get_vals("code");
        let errors = get_vals("error");
        if codes.len() == 1 && !codes[0].is_empty() && errors.is_empty() {
            Some(Ok(codes[0].clone()))
        } else if codes.is_empty() && errors.len() == 1 {
            Some(Err("用户在浏览器中取消或拒绝了 Google 授权".to_string()))
        } else {
            None
        }
    });

    let resp = if matches!(result, Some(Ok(_))) {
        oauth_success_html()
    } else {
        oauth_fail_html()
    };
    let _ = tokio::time::timeout(Duration::from_secs(1), stream.write_all(resp.as_bytes())).await;
    result
}

pub fn open_browser_url(url: &str) {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let op: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = OsStr::new(url).encode_wide().chain(Some(0)).collect();
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

pub async fn run_headless_oauth_flow(
    root: &Path,
    open_browser: bool,
    on_url: impl FnOnce(&str),
) -> Result<TokenResponse, String> {
    let (client_id, client_secret) = resolve_oauth_client(root, None, None).await?;
    let mut ipv4: Option<TcpListener> = None;
    let mut ipv6: Option<TcpListener> = None;
    let port: u16;
    match TcpListener::bind("[::1]:0").await {
        Ok(l6) => {
            port = l6.local_addr().map_err(|e| e.to_string())?.port();
            ipv6 = Some(l6);
            if let Ok(l4) = TcpListener::bind(format!("127.0.0.1:{port}")).await {
                ipv4 = Some(l4);
            }
        }
        Err(_) => {
            let l4 = TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| format!("Cannot bind loopback port: {e}"))?;
            port = l4.local_addr().map_err(|e| e.to_string())?.port();
            ipv4 = Some(l4);
            if let Ok(l6) = TcpListener::bind(format!("[::1]:{port}")).await {
                ipv6 = Some(l6);
            }
        }
    }

    let redirect_uri = if ipv4.is_some() && ipv6.is_some() {
        format!("http://localhost:{port}/oauth-callback")
    } else if ipv4.is_some() {
        format!("http://127.0.0.1:{port}/oauth-callback")
    } else {
        format!("http://[::1]:{port}/oauth-callback")
    };

    let state = Uuid::new_v4().to_string();
    let auth_url = get_auth_url(&client_id, &redirect_uri, &state)?;

    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let (code_tx, mut code_rx) = mpsc::channel::<Result<String, String>>(1);
    let expires_at = Instant::now() + Duration::from_secs(300);

    for listener in [ipv4, ipv6].into_iter().flatten() {
        let st = state.clone();
        let tx = code_tx.clone();
        let mut crx = cancel_rx.clone();
        tokio::spawn(async move {
            let mut conns = JoinSet::new();
            loop {
                if *crx.borrow() {
                    break;
                }
                tokio::select! {
                    _ = crx.changed() => break,
                    _ = tokio::time::sleep_until(expires_at) => {
                        let _ = tx.try_send(Err("浏览器授权超时，请重试".to_string()));
                        break;
                    }
                    done = conns.join_next(), if !conns.is_empty() => {
                        if let Some(Ok(Some(res))) = done {
                            let _ = tx.try_send(res);
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        if let Ok((stream, _)) = accepted {
                            if conns.len() < 8 {
                                conns.spawn(read_callback(stream, st.clone()));
                            }
                        }
                    }
                }
            }
        });
    }

    // Watch stdin for "CANCEL" or parent EOF (when invoked from Electron IPC)
    let cancel_tx_stdin = cancel_tx.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(text) => {
                    if text.trim().eq_ignore_ascii_case("CANCEL") {
                        let _ = cancel_tx_stdin.send(true);
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        // EOF on stdin (if piped from parent that closed stdin)
        // Only treat EOF as cancel if stdin is NOT a terminal
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() {
            let _ = cancel_tx_stdin.send(true);
        }
    });

    on_url(&auth_url);
    if open_browser {
        open_browser_url(&auth_url);
    }

    let code_res = tokio::select! {
        biased;
        msg = code_rx.recv() => msg.unwrap_or_else(|| Err("授权回调通道异常关闭".to_string())),
        _ = cancel_rx.changed() => Err("CANCELLED".to_string()),
        _ = tokio::time::sleep_until(expires_at) => Err("浏览器授权超时，请重试".to_string()),
    };
    let _ = cancel_tx.send(true);

    let code = code_res?;
    exchange_code(&client_id, &client_secret, &code, &redirect_uri).await
}
