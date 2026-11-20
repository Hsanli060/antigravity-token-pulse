# agy-switch-lite

轻量级无头 Antigravity 2.0 账号切换与配额同步引擎（纯 Rust、仅 ~3 MB、无 GUI/TUI/反代冗余模块），是 `antigravity-token-pulse` 内置的独立进程后端引擎。

> 普通用户无需安装 Rust 或手动编译：双击根目录的 `Antigravity-Telemetry-Installer.bat` 会自动从 GitHub Releases 下载并校验由 GitHub Actions 基于本目录源码构建的预编译二进制至 `%LOCALAPPDATA%\agy-switch\agy-switch.exe`。

## 安全与隐私设计

- **Windows DPAPI 本机用户级加密**：所有保存在 `~/.antigravity_tools/accounts/*.json` 中的 `access_token`、`refresh_token`、`id_token` 以及 OAuth 客户端缓存 `oauth-client.json`，写入时均自动调用 Windows `CryptProtectData`（`CurrentUser` 作用域 + `CRYPTPROTECT_UI_FORBIDDEN`）加密为 `dpapi:v1:<base64>` 密文；旧版明文账号文件在首次读取时自动无感迁移为密文。
- **源码零硬编码密钥**：本源码仓库不包含任何 Google OAuth `client_id` 或 `client_secret`。运行期按以下顺序解析：
  1. 环境变量 `AGY_SWITCH_OAUTH_CLIENT_ID` 与 `AGY_SWITCH_OAUTH_CLIENT_SECRET`
  2. 本地 DPAPI 加密缓存 `~/.antigravity_tools/oauth-client.json`
  3. 自动从本机已安装的官方 Antigravity 2.0 / `agy` CLI 目录定位并校验后写入 DPAPI 缓存
- **零第三方服务器**：仅直连 Google 官方 OAuth 与 Cloud Code 配额接口，授权回调仅瞬时监听本地回环地址（`127.0.0.1` / `[::1]`）。

## 编译与部署（Windows）

```powershell
cd tools\agy-switch-lite
cargo build --release
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\agy-switch" | Out-Null
Copy-Item "target\release\agy-switch.exe" "$env:LOCALAPPDATA\agy-switch\agy-switch.exe" -Force
```

## 常用无头 JSON 子命令

```powershell
agy-switch --version --json
agy-switch sync --json
agy-switch accounts list --json
agy-switch add --json
agy-switch refresh [ACCOUNT_ID|EMAIL] --json
agy-switch switch <ACCOUNT_ID|EMAIL> --target app --json
agy-switch delete <ACCOUNT_ID|EMAIL> --json
```
