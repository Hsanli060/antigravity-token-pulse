# Antigravity Token Pulse

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#快速安装一秒上手)

为 **Google Antigravity 2.0 桌面端** 与 **Antigravity CLI (`agy`)** 打造的轻量级**实时 Token 遥测栏**与 **Token 活动热力图面板**（纯本地读取、零网络遥测上传、开箱即用）。

---

## 核心特性

### 1. 实时遥测状态栏（Antigravity 2.0 桌面端 + `agy` CLI）
- **`⚡ t/s` 生成速率**：实时测算当前对话输出吞吐速率
- **上下文环形进度图 (`used / max · pct%`)**：直观展示当前上下文窗口占用与百分比（如 `128k / 1M · 13%`）
- **`Cache%` 缓存命中率**：基于累计 Prompt Cache Read Token 占比实时统计
- **`Σ` 累计消耗**：会话级累计 Token 总量（统一英文紧凑单位 `k` / `M` / `B`）

### 2. Token 活动热力图与分模型账本面板（点击遥测栏展开）
- 点击遥测栏任意位置，打开活动分析弹窗：
  - **每天 (Daily)**：类似 GitHub Contribution 的 53 周热力矩阵，直观查看每日 Token 消耗与热区分布
  - **每周 (Weekly)**：按自然周聚合统计周度 Token 消耗对比
  - **每月 (Monthly) / 累计总量**：按月度及全历史周期统计 Token 消耗总账与构成分布
- **`[端侧 | 模型]` 一键切换与动态模型配色**：
  - 支持在「端侧分布（Desktop / CLI）」与「模型分布（按主模型聚合，自动合并思考档位）」之间一键切换
  - **零硬编码动态识别**：直接从本地会话账本与 SQLite 元数据提取模型列表，未来上架新模型或下架旧模型均自动适配
  - **自适应色盘**：主力模型使用高辨识度暗色主题色盘，超出模型数通过黄金分割角（`137.508°`）动态生成防撞色 HSL 配色；「累计总量」页内置全模型排行榜与悬浮详细账单
- **桌面端 + CLI 数据自动合并**：`agy` CLI 的实时 Token 消耗会自动同步到 `~/.gemini/telemetry-activity-cache.json`，桌面端热力图自动聚合 Antigravity 2.0 与 `agy` 两端历史对话账本。

### 3. 一键安装 / 升级 / 还原
- [`Antigravity-Telemetry-Installer.bat`](Antigravity-Telemetry-Installer.bat) 内置纯 Windows PowerShell + .NET **内存级 ASAR 注入与 SHA-256 完整性重算引擎**：
  - **无需安装 Node.js / npm / `asar`**（仅 `agy` CLI 状态栏需要 Node.js）
  - **双模式资源加载**：
    - 下载仓库 ZIP 解压或 `git clone` 后运行，直接读取同目录 `src/` **纯离线注入**
    - 仅单独下载 `Antigravity-Telemetry-Installer.bat` 时，自动从 jsDelivr 多镜像 / GitHub Raw 拉取 `src/` 模块并缓存到 `~/.gemini/telemetry-mod-cache`
  - 自动探测运行进程或安装目录下的 `app.asar`，首次或客户端升级后自动备份干净原版为 `app.asar.bak`
  - 支持随时双击重新运行：一键**升级/重新注入**或**恢复官方原版**
  - 自动探测 `~/.gemini/antigravity-cli`，安全合并写入 `statusLine` 配置，并自动规避含空格路径在 Windows `cmd.exe` 下的引号截断问题

---

## 快速安装一秒上手（Windows 推荐）

### 方式一：下载完整 ZIP（纯离线，推荐）
1. 点击仓库右上角 **Code -> Download ZIP**（或执行 `git clone https://github.com/Hsanli060/antigravity-token-pulse.git`）
2. 解压后双击运行根目录的 `Antigravity-Telemetry-Installer.bat`（如果 Antigravity 安装在 `C:\Program Files` 下，请**右键 -> 以管理员身份运行**）
3. 等待 1~2 秒自动注入并重启 Antigravity 2.0，即可看到遥测栏；点击遥测栏随时打开 Token 活动热力图面板。

### 方式二：仅下载单个安装脚本
1. 右键「另存为」下载 [`Antigravity-Telemetry-Installer.bat`](https://raw.githubusercontent.com/Hsanli060/antigravity-token-pulse/main/Antigravity-Telemetry-Installer.bat)（保留 `.bat` 后缀）
2. 双击运行即可自动拉取 `src/` 模块、缓存在本地并完成注入。

> **客户端更新后怎么办？**
> 当 Antigravity 2.0 官方自动更新覆盖了 `app.asar` 时，只需**再次双击** `Antigravity-Telemetry-Installer.bat`，1 秒即可无损恢复遥测栏与热力图，所有历史 Token 数据自动保留。

> **如何卸载 / 恢复官方原版？**
> 再次双击运行 `Antigravity-Telemetry-Installer.bat`，在菜单中输入 `2` 并回车，即可从 `app.asar.bak` 还原官方原版并清理 CLI 托管配置。

---

## 手动注入 / 开发者方式

如果你想手动解包注入 `app.asar`，可使用 `src/patch-asar.js`（需要 Node.js）：

```bash
# 1. 解包 app.asar
npx @electron/asar extract "%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar" app-extracted

# 2. 运行注入脚本（内置 vm.Script 语法校验）
node src/patch-asar.js app-extracted

# 3. 重新打包回 app.asar（建议先备份 app.asar.bak）
npx @electron/asar pack app-extracted "%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar"
```

### 单独配置 Antigravity CLI (`agy`)

将 [`src/agy-statusline.js`](src/agy-statusline.js) 放到**不含空格的路径**（例如 `~/.gemini/antigravity-cli/agy-statusline.js` 或 `C:\Users\Public\agy-statusline.js`），并在 `~/.gemini/antigravity-cli/settings.json` 中合并以下配置：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/Public/agy-statusline.js",
    "enabled": true
  }
}
```

---

## 目录结构

```text
antigravity-token-pulse/
├── Antigravity-Telemetry-Installer.bat   # 一键安装 / 升级 / 恢复器（离线读取 src/ 或在线镜像拉取）
├── src/
│   ├── patch-asar.js                     # 桌面端 ASAR 独立注入脚本（Node.js）
│   ├── ipc-block.js                      # Electron 主进程 IPC 数据采集与账本聚合模块
│   ├── preload-part1.js                  # 渲染层样式表与工具函数模块 (1/3)
│   ├── preload-part2.js                  # Token 活动热力图弹窗与交互视图模块 (2/3)
│   ├── preload-part3.js                  # 实时遥测栏 DOM 挂载与轮询模块 (3/3)
│   └── agy-statusline.js                 # agy CLI 终端状态栏 + Token 缓存同步脚本
├── LICENSE                               # MIT License
└── README.md
```

---

## 隐私与安全说明

- **100% 本地统计**：所有 Token 读取与热力图统计均只访问本地 `~/.gemini/antigravity/...` 与 `~/.gemini/telemetry-activity-cache.json`，**不上传任何对话或统计数据到任何服务器**。
- **全部源码可审计**：`src/` 目录下所有注入模块均为明文 JavaScript，安装器不会执行任何隐藏二进制。

---

## License

[MIT](LICENSE)
