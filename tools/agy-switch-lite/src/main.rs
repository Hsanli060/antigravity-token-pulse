mod dpapi;
mod models;
mod oauth;
mod protobuf;
mod quota;
mod store;
mod system;

use models::{now_unix, AccountView, TokenData};
use serde_json::json;
use std::io::Write;
use std::path::Path;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const HELP: &str = "agy-switch (lite headless) - Minimal Antigravity account manager

Usage:
  agy-switch --version [--json]
  agy-switch sync [--json]
  agy-switch accounts list [--json]
  agy-switch list [--json]
  agy-switch add [--json]
  agy-switch delete <ACCOUNT_ID|EMAIL> [--json]
  agy-switch refresh [ACCOUNT_ID|EMAIL] [--json]
  agy-switch switch <ACCOUNT_ID|EMAIL> [--target app|agy] [--json]
";

fn emit_line(val: serde_json::Value) {
    println!("{val}");
    let _ = std::io::stdout().flush();
}

/// Fast local-only alignment (0ms, zero network): matches live WinCred/CLI refresh_token
/// directly against saved accounts or `live-identity-cache.json` (`sha256(rt) -> email`).
fn fast_local_current_align(root: &Path) -> Option<String> {
    let live = system::read_live_credentials()?;
    let (index, accounts) = store::list_accounts(root).ok()?;

    // 1. Direct refresh_token match
    if let Some(acc) = accounts
        .iter()
        .find(|a| !a.token.refresh_token.is_empty() && a.token.refresh_token == live.refresh_token)
    {
        if index.current_account_id.as_deref() != Some(acc.id.as_str()) {
            let _ = store::set_current_account_id(root, &acc.id);
        }
        store::save_identity_cache_entry(root, &store::sha256_hex(&live.refresh_token), &acc.email);
        return Some(acc.id.clone());
    }

    // 2. Match via id_token JWT email (if present)
    if let Some(email) = live.id_token.as_deref().and_then(system::decode_jwt_email) {
        if let Some(acc) = accounts
            .iter()
            .find(|a| a.email.eq_ignore_ascii_case(&email))
        {
            if index.current_account_id.as_deref() != Some(acc.id.as_str()) {
                let _ = store::set_current_account_id(root, &acc.id);
            }
            store::save_identity_cache_entry(root, &store::sha256_hex(&live.refresh_token), &acc.email);
            return Some(acc.id.clone());
        }
    }

    // 3. Match via local rt_hash -> email cache
    let rt_hash = store::sha256_hex(&live.refresh_token);
    let cache = store::load_identity_cache(root);
    if let Some(cached_email) = cache.get(&rt_hash) {
        if let Some(acc) = accounts
            .iter()
            .find(|a| a.email.eq_ignore_ascii_case(cached_email))
        {
            if index.current_account_id.as_deref() != Some(acc.id.as_str()) {
                let _ = store::set_current_account_id(root, &acc.id);
            }
            return Some(acc.id.clone());
        }
    }

    None
}

/// Full live synchronization: resolves live WinCred/CLI credential (via cache or userinfo),
/// aligns `current_account_id` if already saved, or auto-imports with initial quota if missing.
async fn cmd_sync(root: &Path) -> Result<serde_json::Value, String> {
    let Some(live) = system::read_live_credentials() else {
        return Ok(json!({
            "schema_version": 1,
            "synced": false,
            "imported": false,
            "changed": false,
            "current_account_id": null,
            "email": null,
            "reason": "no_live_credential"
        }));
    };

    let rt_hash = store::sha256_hex(&live.refresh_token);
    let (index, accounts) = store::list_accounts(root)?;

    // Fast path 1: exact refresh_token match
    if let Some(acc) = accounts
        .iter()
        .find(|a| a.token.refresh_token == live.refresh_token)
    {
        store::save_identity_cache_entry(root, &rt_hash, &acc.email);
        let changed = store::set_current_account_id(root, &acc.id)?;
        return Ok(json!({
            "schema_version": 1,
            "synced": true,
            "imported": false,
            "changed": changed,
            "current_account_id": acc.id,
            "email": acc.email
        }));
    }

    // Fast path 2: cached rt_hash -> email already in saved accounts
    let cache = store::load_identity_cache(root);
    if let Some(cached_email) = cache.get(&rt_hash) {
        if let Some(acc) = accounts
            .iter()
            .find(|a| a.email.eq_ignore_ascii_case(cached_email))
        {
            let changed = store::set_current_account_id(root, &acc.id)?;
            return Ok(json!({
                "schema_version": 1,
                "synced": true,
                "imported": false,
                "changed": changed,
                "current_account_id": acc.id,
                "email": acc.email
            }));
        }
    }

    // Network resolve: use live access_token first (or refresh live refresh_token) to get UserInfo
    let (access_token, expires_in, id_token, user_info) =
        if !live.access_token.is_empty() {
            match oauth::get_user_info(&live.access_token).await {
                Ok(u) => (live.access_token.clone(), 1800, live.id_token.clone(), u),
                Err(_) => {
                    let t = oauth::refresh_access_token(
                        root,
                        &live.refresh_token,
                        live.id_token.as_deref(),
                    )
                    .await?;
                    let u = oauth::get_user_info(&t.access_token).await?;
                    (t.access_token, t.expires_in, t.id_token.or(live.id_token.clone()), u)
                }
            }
        } else {
            let t =
                oauth::refresh_access_token(root, &live.refresh_token, live.id_token.as_deref())
                    .await?;
            let u = oauth::get_user_info(&t.access_token).await?;
            (t.access_token, t.expires_in, t.id_token.or(live.id_token.clone()), u)
        };

    let email = user_info.email.trim().to_string();
    if email.is_empty() {
        return Err("Unable to resolve live account email".to_string());
    }
    store::save_identity_cache_entry(root, &rt_hash, &email);

    // If account with this email is already saved, mark it current (keep its working OAuth token)
    if let Some(existing) = accounts
        .iter()
        .find(|a| a.email.eq_ignore_ascii_case(&email))
    {
        let changed = index.current_account_id.as_deref() != Some(existing.id.as_str());
        if changed {
            store::set_current_account_id(root, &existing.id)?;
        }
        return Ok(json!({
            "schema_version": 1,
            "synced": true,
            "imported": false,
            "changed": changed,
            "current_account_id": existing.id,
            "email": existing.email
        }));
    }

    // Not in saved accounts yet -> auto-import and fetch initial quota!
    let (fetched_quota, project_id) = match quota::fetch_quota(&access_token, None).await {
        Ok((q, pid)) => (Some(q), pid),
        Err(_) => (None, None),
    };
    let token_data = TokenData::new(
        access_token,
        live.refresh_token,
        expires_in,
        Some(email.clone()),
        project_id,
        false,
        id_token,
    );
    let (saved, created) = store::upsert_account(
        root,
        email.clone(),
        user_info.display_name(),
        token_data,
        fetched_quota,
        true,
    )?;

    Ok(json!({
        "schema_version": 1,
        "synced": true,
        "imported": created,
        "changed": true,
        "current_account_id": saved.id,
        "email": saved.email
    }))
}

fn cmd_list(root: &Path) -> Result<serde_json::Value, String> {
    let _ = fast_local_current_align(root);
    let (index, accounts) = store::list_accounts(root)?;
    let cur_id = index.current_account_id.as_deref();
    let views: Vec<AccountView> = accounts
        .into_iter()
        .map(|a| {
            let is_cur = cur_id == Some(a.id.as_str());
            AccountView::from_account(a, is_cur)
        })
        .collect();
    Ok(json!({
        "schema_version": 1,
        "accounts": views,
        "current_target": index.current_target_ide
    }))
}

async fn cmd_add(root: &Path) -> i32 {
    let token_res = oauth::run_headless_oauth_flow(root, true, |auth_url| {
        emit_line(json!({ "event": "auth_url", "url": auth_url }));
    })
    .await;

    let token_resp = match token_res {
        Ok(t) => t,
        Err(e) if e == "CANCELLED" => {
            emit_line(json!({ "event": "cancelled" }));
            return 0;
        }
        Err(e) => {
            emit_line(json!({ "event": "error", "message": e }));
            return 1;
        }
    };

    let Some(refresh_token) = token_resp.refresh_token.filter(|s| !s.trim().is_empty()) else {
        emit_line(json!({
            "event": "error",
            "message": "未能获取到 Refresh Token，请撤销旧授权后重试"
        }));
        return 1;
    };

    let user_info = match oauth::get_user_info(&token_resp.access_token).await {
        Ok(u) => u,
        Err(_) => {
            emit_line(json!({
                "event": "error",
                "message": "获取 Google 账号信息失败，请检查网络代理后重试"
            }));
            return 1;
        }
    };

    let (fetched_quota, project_id) = match quota::fetch_quota(&token_resp.access_token, None).await {
        Ok((q, pid)) => (Some(q), pid),
        Err(_) => (None, None),
    };

    let token_data = TokenData::new(
        token_resp.access_token,
        refresh_token.clone(),
        token_resp.expires_in,
        Some(user_info.email.clone()),
        project_id,
        false,
        token_resp.id_token,
    );

    match store::upsert_account(
        root,
        user_info.email.clone(),
        user_info.display_name(),
        token_data,
        fetched_quota,
        false,
    ) {
        Ok((acc, _)) => {
            store::save_identity_cache_entry(root, &store::sha256_hex(&refresh_token), &acc.email);
            emit_line(json!({
                "event": "success",
                "account_id": acc.id,
                "email": acc.email
            }));
            0
        }
        Err(e) => {
            emit_line(json!({ "event": "error", "message": e }));
            1
        }
    }
}

async fn cmd_refresh(root: &Path, selector: Option<&str>) -> Result<serde_json::Value, String> {
    let (_, accounts) = store::list_accounts(root)?;
    let targets: Vec<_> = match selector {
        Some(sel) => accounts
            .into_iter()
            .filter(|a| a.id == sel || a.email.eq_ignore_ascii_case(sel))
            .collect(),
        None => accounts,
    };
    if selector.is_some() && targets.is_empty() {
        return Err("No matching account".to_string());
    }

    let total = targets.len();
    // Pre-warm OAuth client cache once before fanning out concurrently if any token needs refresh
    let needs_oauth_warm = targets.iter().any(|a| {
        !a.disabled
            && (a.token.expiry_timestamp <= now_unix() + 900
                || a.token.access_token.trim().is_empty())
    });
    if needs_oauth_warm {
        let _ = oauth::resolve_oauth_client(root, None, None).await;
    }

    let max_concurrency = std::env::var("AGY_SWITCH_REFRESH_CONCURRENCY")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .map(|n| n.clamp(1, 32))
        .unwrap_or(20);
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(max_concurrency));
    let root_buf = root.to_path_buf();
    let mut set = tokio::task::JoinSet::new();

    for (idx, mut acc) in targets.into_iter().enumerate() {
        if acc.disabled {
            set.spawn(async move {
                (
                    idx,
                    false,
                    json!({ "id": acc.id, "email": acc.email, "ok": false, "reason": "disabled" }),
                )
            });
            continue;
        }
        let sem_clone = sem.clone();
        let root_clone = root_buf.clone();
        set.spawn(async move {
            let _permit = sem_clone.acquire_owned().await;
            match oauth::ensure_fresh_token(&root_clone, &acc.token).await {
                Ok(fresh) => {
                    acc.token = fresh;
                    match quota::fetch_quota(&acc.token.access_token, acc.token.project_id.as_deref())
                        .await
                    {
                        Ok((mut q, pid)) => {
                            if let Some(prev) = acc.quota.as_ref() {
                                if q.subscription_tier.is_none() {
                                    q.subscription_tier = prev.subscription_tier.clone();
                                }
                            }
                            if pid.is_some() {
                                acc.token.project_id = pid;
                            }
                            acc.quota = Some(q);
                            let _ = store::save_account(&root_clone, &acc);
                            (
                                idx,
                                true,
                                json!({ "id": acc.id, "email": acc.email, "ok": true }),
                            )
                        }
                        Err(e) => (
                            idx,
                            false,
                            json!({ "id": acc.id, "email": acc.email, "ok": false, "error": e }),
                        ),
                    }
                }
                Err(e) => (
                    idx,
                    false,
                    json!({ "id": acc.id, "email": acc.email, "ok": false, "error": e }),
                ),
            }
        });
    }

    let mut ordered: Vec<(usize, bool, serde_json::Value)> = Vec::with_capacity(total);
    while let Some(res) = set.join_next().await {
        if let Ok(item) = res {
            ordered.push(item);
        }
    }
    ordered.sort_by_key(|(idx, _, _)| *idx);

    let mut success = 0usize;
    let mut failed = 0usize;
    let mut details = Vec::with_capacity(ordered.len());
    for (_, ok, detail) in ordered {
        if ok {
            success += 1;
        } else {
            failed += 1;
        }
        details.push(detail);
    }

    Ok(json!({
        "schema_version": 1,
        "total": total,
        "success": success,
        "failed": failed,
        "details": details
    }))
}

async fn cmd_switch(
    root: &Path,
    selector: &str,
    target: &str,
    is_worker: bool,
) -> Result<serde_json::Value, String> {
    let (_, accounts) = store::list_accounts(root)?;
    let mut acc = accounts
        .into_iter()
        .find(|a| a.id == selector || a.email.eq_ignore_ascii_case(selector))
        .ok_or_else(|| format!("Account not found: {selector}"))?;

    if acc.disabled || acc.validation_blocked {
        return Err("Account is disabled or validation blocked".to_string());
    }

    let fresh = oauth::ensure_fresh_token(root, &acc.token).await?;
    acc.token = fresh;
    acc.last_used = now_unix();
    store::save_account(root, &acc)?;
    store::save_identity_cache_entry(root, &store::sha256_hex(&acc.token.refresh_token), &acc.email);

    if target == "agy" {
        let _lock = store::SwitchLock::acquire(root)?;
        system::write_credentials(&acc, false)?;
        store::set_current_account_id(root, &acc.id)?;
        return Ok(json!({
            "schema_version": 1,
            "switched": true,
            "account_id": acc.id,
            "email": acc.email,
            "target": "agy"
        }));
    }

    let (running_pids, running_exe) = system::find_running_antigravity();
    let was_running = !running_pids.is_empty();

    // On Windows, if Antigravity is running and we are not already the detached WMI worker,
    // respawn ourselves via WMI Win32_Process.Create so we are completely outside Antigravity's
    // process tree and Windows Job Object (immune to KILL_ON_JOB_CLOSE and nested jobs).
    if !is_worker && (was_running || system::is_in_kill_on_close_job()) {
        if let Ok(true) = system::respawn_switch_outside_job(&acc.id, target) {
            return Ok(json!({
                "schema_version": 1,
                "switched": true,
                "detached_worker": true,
                "account_id": acc.id,
                "email": acc.email,
                "target": target
            }));
        }
    }

    let _lock = store::SwitchLock::acquire(root)?;
    let (running_pids_now, running_exe_now) = system::find_running_antigravity();
    let should_relaunch = was_running || is_worker || !running_pids_now.is_empty();
    let relaunch_exe = running_exe_now
        .or(running_exe)
        .or_else(system::find_antigravity_exe);

    if !running_pids_now.is_empty() {
        system::close_antigravity_gracefully()?;
    }

    system::recover_zero_filled_pbtxt();
    system::write_credentials(&acc, true)?;
    store::set_current_account_id(root, &acc.id)?;

    if should_relaunch {
        if let Some(exe) = relaunch_exe {
            system::start_antigravity_detached(&exe)?;
        }
    }

    Ok(json!({
        "schema_version": 1,
        "switched": true,
        "account_id": acc.id,
        "email": acc.email,
        "target": target
    }))
}

#[tokio::main]
async fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let json_flag = raw_args.iter().any(|a| a == "--json");
    let worker_flag = raw_args.iter().any(|a| a == "--worker");
    let mut args: Vec<&str> = raw_args
        .iter()
        .map(String::as_str)
        .filter(|a| *a != "--json" && *a != "--cli" && *a != "--worker")
        .collect();
    if args.first() == Some(&"accounts") {
        args.remove(0);
    }

    match args.as_slice() {
        [] | ["--help"] | ["-h"] | ["help"] => {
            if json_flag {
                emit_line(json!({ "schema_version": 1, "help": HELP }));
            } else {
                print!("{HELP}");
            }
            return;
        }
        ["--version"] | ["-V"] => {
            if json_flag {
                emit_line(json!({
                    "schema_version": 1,
                    "name": "agy-switch",
                    "version": VERSION,
                    "capabilities": ["sync", "add", "delete", "refresh", "switch"]
                }));
            } else {
                println!("agy-switch {VERSION}");
            }
            return;
        }
        _ => {}
    }

    let root = match store::data_dir() {
        Ok(p) => p,
        Err(e) => {
            emit_line(json!({ "schema_version": 1, "error": { "code": 1, "message": e } }));
            std::process::exit(1);
        }
    };

    if matches!(args.as_slice(), ["add"]) {
        let code = cmd_add(&root).await;
        std::process::exit(code);
    }

    let result = match args.as_slice() {
        ["list"] => cmd_list(&root),
        ["sync"] => cmd_sync(&root).await,
        ["delete", sel] => store::delete_account(&root, sel).map(|id| {
            json!({
                "schema_version": 1,
                "deleted": true,
                "account_id": id
            })
        }),
        ["refresh"] => cmd_refresh(&root, None).await,
        ["refresh", sel] => cmd_refresh(&root, Some(sel)).await,
        ["switch", sel] => cmd_switch(&root, sel, "app", worker_flag).await,
        ["switch", sel, "--target", target] if matches!(*target, "app" | "agy" | "ide") => {
            cmd_switch(&root, sel, target, worker_flag).await
        }
        _ => Err("Invalid command or arguments. Run agy-switch --help.".to_string()),
    };

    match result {
        Ok(val) => emit_line(val),
        Err(msg) => {
            if json_flag {
                eprintln!(
                    "{}",
                    json!({ "schema_version": 1, "error": { "code": 1, "message": msg } })
                );
            } else {
                eprintln!("agy-switch: {msg}");
            }
            std::process::exit(1);
        }
    }
}
