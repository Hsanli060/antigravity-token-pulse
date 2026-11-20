# Antigravity Token Pulse

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#快速安装一秒上手)

为 **Google Antigravity 2.0 桌面端** 与 **Antigravity CLI (`agy`)** 打造的轻量级**实时 Token 遥测栏**与 **Token 活动热力图面板**（纯本地读取、零网络遥测上传、开箱即用）。

---

## 核心特性

### 1. 实时遥测状态栏（Antigravity 2.0 桌面端 + `agy` CLI）
- **`⚡ t/s` 生成速率**：实时测算当前对话输出吞吐速率
- **上下文环形进度图 (`used / 1M · pct%`)**：桌面端与 `agy` CLI 统一采用 **`1M`（`1,000,000` tokens）固定上下文窗口口径**计算并展示占用与百分比（如 `128k / 1M · 13%`），确保两端读数完全一致（客户端实际自动压缩阈值仍以官方默认行为为准）
- **`Cache%` 缓存命中率**：基于累计 Prompt Cache Read Token 占比实时统计
- **`Σ` 累计消耗**：会话级累计 Token 总量（统一英文紧凑单位 `k` / `M` / `B`）

### 2. Token 活动热力图与分模型账本面板（点击遥测栏展开）
- 点击遥测栏任意位置，打开活动分析弹窗：
  - **每天 (Daily)**：类似 GitHub Contribution 的 53 周热力矩阵，直观查看每日 Token 消耗与热区分布
  - **每周 (Weekly)**：按自然周聚合统计周度 Token 消耗对比
  - **每月 (Monthly) / 累计总量**：按月度及全历史周期统计 Token 消耗总账与构成分布
- **`[端侧 | 模型]` 一键切换与动态模型配色**：
  - 支持在「端侧分布（Desktop / CLI）」与「模型分布（按主模型聚合，自动合并思考档位）」之间一键切换
  - **零硬编码动态识别**：直接从本地会话账本与 SQLite 元数据提取模型列表（兼容官方 `@default` / 日期后缀及 `provider/` 前缀），未来上架或下架模型均可自动适配
  - **自适应浅 / 深色主题**：底栏文字、SVG 图标与 Token 活动热力图弹窗均会自动感知 Antigravity 2.0 官方浅色 / 深色主题并实时切换配色，切换主题无需重启客户端
- **桌面端 + CLI 数据自动合并**：`agy` CLI 的实时 Token 消耗会自动同步到 `~/.gemini/telemetry-activity-cache.json`（支持 `ANTIGRAVITY_CLI_HOME` 自定义路径），桌面端热力图自动聚合 Antigravity 2.0 与 `agy` 两端历史对话账本。

### 2.5 可选外部 CLI 账号管理桥接（默认隐藏、按需启用）
- **零侵入与进程隔离设计**：本插件本身**不包含**任何 OAuth 密钥、凭据解析或网络配额接口，仅作为轻量前端入口；仅在检测到本机存在外部 [`agy-switch`](https://github.com/anglee0323/agy-switch) 或其精简无头兼容 CLI（`agy-switch.exe` / `agy-switch`）时，在 Token 活动弹窗中自动显示 **「账号」** 标签页（未安装时完全隐藏，零界面干扰），且 5 个标签页统一固定为「每天」视图基准尺寸，切换无跳动。
- **核心交互（高信息密度紧凑视图）**：
  - **单行状态摘要 + 双列动态仪表盘卡片**：顶部为单行轻量状态条（当前激活账号 / 可用数 / 短周期与长周期最高余量），列表采用双列卡片网格（窄屏自动单列），零硬编码动态适配 Free / Pro / Ultra 等不同套餐的任意模型池数量与限额周期；每个双周期池采用「左短周期细进度条 + 右动态外圈进度圆环（环内直接展示长周期余量，悬停查看重置时间，耗尽时自动外显倒计时）」，单周期池自动以进度条 + 对齐标签展示；
  - **自动对齐当前登录账号 (`同步当前`)**：若外部 CLI 声明支持 `sync` 能力（通过 `--version --json` 探测），打开弹窗时会自动静默对齐并导入当前正在登录的 Antigravity 2.0 账号，也可手动点击 **「同步当前」**；
  - **添加账号 (`+ 添加账号`)**：若外部 CLI 支持原生 `add --json` 则直接无窗口拉起；否则自动回退为后台无窗口伪终端（Windows ConPTY / Unix PTY）静默驱动 Google OAuth 并打开浏览器登录（全程无黑框）；面板内提供「重新打开浏览器 / 复制链接 / 取消」，授权完成后自动同步；
  - **删除账号 (`删除`)**：内联二次确认（**「确认删除 / 取消」**）后，优先调用外部 CLI 原生 `delete <id> --json`，否则原子清理本地 `accounts.json` 索引与对应条目文件（不影响正在运行的客户端会话）；
  - **刷新额度 (`刷新额度`)**：手动按需触发外部 CLI 查询最新配额（不开启后台定时轮询）；
  - **切换账号 (`切换`)**：内联二次确认（**「确认切换 / 取消」**）防误触；确认后以独立脱离子进程（`detached`、`shell: false`）交由外部 CLI 优雅关闭并重启客户端，同步切换 Antigravity 2.0 与 `agy` CLI。
- **CLI 路径自动探测顺序**（无需改代码）：
  1. 环境变量 `ANTIGRAVITY_SWITCH_CLI`（可填可执行文件路径或其所在目录）
  2. 本地配置文件 `~/.gemini/telemetry-switch-cli.json` 中的 `{"cliPath": "..."}`
  3. 常见默认安装目录（如 Windows 下的 `%LOCALAPPDATA%\agy-switch\agy-switch.exe`、`%LOCALAPPDATA%\Programs\agy-switch\agy-switch.exe`、`~/.gemini/tools/agy-switch/agy-switch.exe`）及系统 `PATH`

### 3. 一键安装 / 升级 / 还原
- [`Antigravity-Telemetry-Installer.bat`](Antigravity-Telemetry-Installer.bat) 内置纯 Windows PowerShell + .NET **内存级 ASAR 注入与 SHA-256 多块完整性重算引擎**：
  - **无需安装 Node.js / npm / `asar`**（仅 `agy` CLI 状态栏需要 Node.js >= 18）
  - **双模式资源加载**：
    - 下载仓库 ZIP 解压或 `git clone` 后运行，直接读取同目录 `src/` **纯离线注入**
    - 仅单独下载 `Antigravity-Telemetry-Installer.bat` 时，自动从 jsDelivr 多镜像 / GitHub Raw 拉取 `src/` 模块（按原始字节流严格 UTF-8 解码，防止代理剥离 charset 导致中文乱码）并缓存到 `~/.gemini/telemetry-mod-cache`
  - **多来源自动探测**：通过当前用户会话进程路径、Windows 注册表卸载项（`HKCU` / `HKLM` / `WOW6432Node`）及常见安装目录自动定位 `app.asar`
  - **安全防护**：写入前检测 `Antigravity.exe` Electron Fuse `EnableEmbeddedAsarIntegrityValidation` 熔断位；若本机存在 `node`，自动使用 `vm.Script` 对修改后的脚本做语法预校验，并验证 ASAR JSON 头与所有文件偏移及分块 SHA-256 完整性后再原子替换
  - 首次或客户端升级后自动备份干净原版为 `app.asar.bak`，支持随时重新运行一键**升级/重新注入**或**恢复官方原版**

---

## Antigravity 2.0 与 Antigravity IDE 的区别

| 产品形态 | 内核与目录特征 | 桌面端注入支持 | `agy` CLI 状态栏 |
| :--- | :--- | :--- | :--- |
| **Antigravity 2.0 桌面端** | 独立 Electron 客户端，安装目录下包含 `resources\app.asar`（及 `resources\app.asar.unpacked`） | **支持**（自动识别并注入遥测栏与热力图） | **支持** |
| **Antigravity IDE** | 基于 VS Code 内核，应用目录为解包形式 `resources\app\`（**无 `app.asar`**） | **不适用**（安装器会提示区分并自动跳过桌面端） | **支持**（可照常自动配置 CLI 状态栏） |

> 如果你的电脑仅安装了 Antigravity IDE（没有安装 Antigravity 2.0 桌面端），运行安装器时会看到明确的友好提示，并直接继续完成 `agy` CLI 状态栏配置。

---

## 快速安装一秒上手（Windows 推荐）

### 方式一：下载完整 ZIP（纯离线，推荐）
1. 点击仓库右上角 **Code -> Download ZIP**（或执行 `git clone https://github.com/Hsanli060/antigravity-token-pulse.git`）
2. 解压后双击运行根目录的 `Antigravity-Telemetry-Installer.bat`（如果 Antigravity 安装在 `C:\Program Files` 下，请**右键 -> 以管理员身份运行**）
3. 等待 1~2 秒自动注入并重启 Antigravity 2.0，即可看到遥测栏；点击遥测栏随时打开 Token 活动热力图面板。

### 方式二：仅下载单个安装脚本
1. 右键「另存为」下载 [`Antigravity-Telemetry-Installer.bat`](https://raw.githubusercontent.com/Hsanli060/antigravity-token-pulse/main/Antigravity-Telemetry-Installer.bat)（保留 `.bat` 后缀；仓库已配置 `.gitattributes` 使 `Download ZIP` 与 `git clone` 自动签出标准 CRLF，且脚本第 1 行为纯 ASCII 单行引导头，即使从 Raw 直接下载得到 LF 行尾也可在 `cmd.exe` 下正常执行）
2. 双击运行即可自动拉取 `src/` 模块、缓存在本地并完成注入。

### 无交互模式与环境变量（CMD / PowerShell 双示例）

安装器支持通过环境变量指定目标路径、自定义 CLI 目录与无交互模式（自动跳过暂停与交互菜单）：
- `ANTIGRAVITY_ASAR_PATH`：指定 `app.asar` 或 Antigravity 安装目录路径（设置后不会关闭宿主当前运行的 Antigravity 进程）
- `ANTIGRAVITY_CLI_HOME`：自定义 CLI 配置目录（默认 `%USERPROFILE%\.gemini\antigravity-cli`）
- `ANTIGRAVITY_INSTALLER_MODE`：`install`（安装/升级）或 `restore`（卸载还原）

**CMD 示例：**

```bat
set "ANTIGRAVITY_INSTALLER_MODE=install"
set "ANTIGRAVITY_ASAR_PATH=%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar"
set "ANTIGRAVITY_CLI_HOME=%USERPROFILE%\.gemini\antigravity-cli"
cmd.exe /c Antigravity-Telemetry-Installer.bat
```

还原卸载（CMD）：

```bat
set "ANTIGRAVITY_INSTALLER_MODE=restore"
cmd.exe /c Antigravity-Telemetry-Installer.bat
```

**PowerShell 示例：**

```powershell
$env:ANTIGRAVITY_INSTALLER_MODE = "install"
$env:ANTIGRAVITY_ASAR_PATH = "$env:LOCALAPPDATA\Programs\Antigravity\resources\app.asar"
$env:ANTIGRAVITY_CLI_HOME = "$env:USERPROFILE\.gemini\antigravity-cli"
cmd.exe /c .\Antigravity-Telemetry-Installer.bat
```

还原卸载（PowerShell）：

```powershell
$env:ANTIGRAVITY_INSTALLER_MODE = "restore"
cmd.exe /c .\Antigravity-Telemetry-Installer.bat
```

> **客户端更新后怎么办？**
> 当 Antigravity 2.0 官方自动更新覆盖了 `app.asar` 时，只需**再次双击** `Antigravity-Telemetry-Installer.bat`，1 秒即可无损恢复遥测栏与热力图，所有历史 Token 数据自动保留。

> **如何卸载 / 恢复官方原版？**
> 再次双击运行 `Antigravity-Telemetry-Installer.bat`，在菜单中输入 `2` 并回车，即可从 `app.asar.bak` 还原官方原版（或自动剥离注入块）并清理 CLI 托管配置。

---

## 含空格用户名 / 路径回退机制说明（`agy` CLI 状态栏）

1. **Node.js >= 18 前置校验**：在向 `settings.json` 写入 `"enabled": true` 之前，安装器会先通过 `cmd.exe /c node -v` 校验本机 Node.js 是否存在且主版本 `>= 18`。若未检测到 Node >= 18，会明确警告并跳过启用 `statusLine`，防止 `agy` 因执行命令失败而自动禁用状态栏。
2. **含空格路径自动规避**：由于 Windows `cmd.exe` 解析命令行时未加引号的空格路径会被截断，当 `%USERPROFILE%\.gemini\antigravity-cli` 路径包含空格（如用户名含空格）时，安装器会按以下顺序自动探测**不含空格且可写**的部署路径：
   1. 优先尝试当前目录的 Windows 8.3 短路径（若卷启用了短文件名且可写）
   2. 通过 `Test-DirWritable` 可写性测试回退至 `%ProgramData%\antigravity-telemetry\agy-statusline.js`
   3. 若 `%ProgramData%` 不可写，继续通过 `Test-DirWritable` 测试回退至 `%PUBLIC%\antigravity-telemetry\agy-statusline.js`（或系统盘根目录下的 `antigravity-telemetry`）

---

## 手动注入 / 开发者方式

### 方式 A：直接对 `app.asar` 原地注入（推荐，自动保留 `app.asar.unpacked`）

`src/patch-asar.js` 已内置完整的 ASAR 读写、多块 SHA-256 校验、Electron Fuse 检查与 `vm.Script` 语法预校验，无需手动解包即可原地安全注入：

**CMD：**
```bat
node src\patch-asar.js "%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar"
:: 如需还原：
node src\patch-asar.js "%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar" --restore
```

**PowerShell：**
```powershell
node src/patch-asar.js "$env:LOCALAPPDATA\Programs\Antigravity\resources\app.asar"
# 如需还原：
node src/patch-asar.js "$env:LOCALAPPDATA\Programs\Antigravity\resources\app.asar" --restore
```

### 方式 B：手动解包 / 打包（注意 `app.asar.unpacked`）

> ⚠️ **重要提醒**：`resources` 目录下存在与 `app.asar` 配套的 **`app.asar.unpacked`** 原生二进制与 MCP 模块目录！
> 如果你手动解包并重新打包 `app.asar`，**切勿删除或破坏 `resources\app.asar.unpacked`**，也不要在不保留 `unpacked` 标记的情况下重打（`@electron/asar extract` 默认不会把原生 `.node` / 外部解压资源重新写回原路径关系；重打包时建议先完整备份 `app.asar` 与 `app.asar.unpacked`，并在同级存在 `app.asar.unpacked` 的情况下使用 `--unpack` 规则保持原生模块清单一致，或直接使用上方**方式 A** 原地修改 `app.asar`）。

**CMD：**
```bat
copy "%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar" "%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar.bak"
npx @electron/asar extract "%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar" app-extracted
node src\patch-asar.js app-extracted
npx @electron/asar pack app-extracted "%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar" --unpack "{*.node,**/chrome-devtools-mcp/**}"
```

**PowerShell：**
```powershell
Copy-Item "$env:LOCALAPPDATA\Programs\Antigravity\resources\app.asar" "$env:LOCALAPPDATA\Programs\Antigravity\resources\app.asar.bak"
npx @electron/asar extract "$env:LOCALAPPDATA\Programs\Antigravity\resources\app.asar" app-extracted
node src/patch-asar.js app-extracted
npx @electron/asar pack app-extracted "$env:LOCALAPPDATA\Programs\Antigravity\resources\app.asar" --unpack "{*.node,**/chrome-devtools-mcp/**}"
```

### 单独配置 Antigravity CLI (`agy`)

确保本机已安装 **Node.js >= 18**（`cmd.exe /c node -v` 可用），将 [`src/agy-statusline.js`](src/agy-statusline.js) 放到**不含空格的可写路径**（例如 `~/.gemini/antigravity-cli/agy-statusline.js`、或用户名含空格时放到 `C:\ProgramData\antigravity-telemetry\agy-statusline.js` / `C:\Users\Public\antigravity-telemetry\agy-statusline.js`），并在 `~/.gemini/antigravity-cli/settings.json`（使用**无 BOM UTF-8** 编码）中合并以下配置：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/Public/antigravity-telemetry/agy-statusline.js",
    "enabled": true
  }
}
```

---

## 目录结构

```text
antigravity-token-pulse/
├── .gitattributes                        # 显式 *.bat/*.cmd 为 CRLF（配合单行引导头兼容 Raw LF 与 ZIP），*.js/*.md 为 LF
├── Antigravity-Telemetry-Installer.bat   # 一键安装 / 升级 / 恢复器（离线读取 src/ 或在线镜像拉取）
├── src/
│   ├── patch-asar.js                     # 桌面端 ASAR 独立注入脚本（支持目录与 .asar 原地注入/还原）
│   ├── ipc-block.js                      # Electron 主进程 IPC 数据采集、账本聚合与可选外部 CLI 桥接模块
│   ├── preload-part1.js                  # 渲染层样式表与主题/工具函数模块 (1/3)
│   ├── preload-part2.js                  # Token 活动热力图与可选账号管理弹窗视图模块 (2/3)
│   ├── preload-part3.js                  # 实时遥测栏 DOM 挂载与轮询模块 (3/3)
│   └── agy-statusline.js                 # agy CLI 终端状态栏 + Token 缓存同步脚本
├── tests/
│   └── account-switcher-bridge.test.js   # 外部 CLI 桥接安全、解析与注入语法自动化测试
├── .gitignore
├── LICENSE                               # MIT License
└── README.md
```

---

## 隐私与安全说明

- **100% 本地统计**：所有 Token 读取与热力图统计均只访问本地 `~/.gemini/antigravity/...`、`~/.gemini/antigravity-cli/...` 与 `~/.gemini/telemetry-activity-cache.json`，**不上传任何对话或统计数据到任何服务器**。
- **可选外部 CLI 桥接安全边界**：账号切换 IPC 仅校验本地 `localhost`/`127.0.0.1` 顶层来源、以 `shell: false` 严格白名单调用用户自行安装的外部 `agy-switch` CLI，**绝不向渲染层传递任何 Token / 密钥字段**；未安装外部 CLI 时功能自动隐藏。
- **全部源码可审计**：`src/` 目录下所有注入模块均为明文 JavaScript，安装器不会执行任何隐藏二进制。

---

## License

[MIT](LICENSE)
