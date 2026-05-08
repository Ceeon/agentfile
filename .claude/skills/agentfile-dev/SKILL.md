---
name: agentfile-dev
description: |
  诊断、启动、验证、安装和修复 Agentfile 本地开发环境（macOS、Windows）。当用户要
  启动 Agentfile、检查是否已运行、排查启动失败、定位本地 bug、验证环境或给别人部署可边用边改的 Agentfile 环境时使用。
---

# Agentfile Dev

项目级 skill：让 agent 能自己诊断、启动、验证和修复 Agentfile。安装只是辅助能力。

核心约束：

- 默认用可边用边改的本地运行方式：macOS arm64 用 `task electron:quickdev`，Windows amd64 用 `task electron:winquickdev`，其他平台用 `task dev`。
- 先检查是否已经启动，避免重复开多个 dev server。
- 不执行 `task package`，除非用户明确要构建安装包。
- `http://localhost:5173/` 只是 Electron renderer 的 Vite dev server，不是用户应该打开的网页；真正的界面在 Agentfile Electron 窗口里。
- Agentfile 按可持续编辑的本地应用处理，不在用户可见文案里区分发布渠道标签。
- 数据/配置目录按平台隔离：
  - macOS data: `~/Library/Application Support/waveterm2-dev`
  - Windows data: `%LOCALAPPDATA%\waveterm2-dev\Data`
  - config: `~/.config/waveterm2-dev`
- 如果仓库有未提交改动，不要为了更新而 `reset`、`checkout --` 或强行覆盖。

## 标准流程

1. 先自检，不要直接盲目启动。
   - 用户问 bug、启动失败、有没有运行、能不能测试时，先运行 `status` 或 `diagnose`。
   - `status` 是轻量检查：依赖、仓库、进程、Vite 端口、日志。
   - `diagnose` 是完整检查：`status` + 开发构建，用来暴露编译/打包错误。

2. 确认仓库路径。
   - 当前目录是 Agentfile 仓库时直接使用当前目录。
   - 否则脚本会从本 skill 所在路径反推项目根目录。
   - 仓库识别接受 `package.json` 中的 `name` 为 `agentfile`，并兼容历史 `waveterm`。
   - 需要给别人安装时，可用 `AGENTFILE_REPO_URL` 指定 fork 地址；默认是 `https://github.com/Ceeon/agentfile.git`。

3. 检查依赖。
   - 必要命令：`git`、`node`、`npm`、`go`、`task`。
   - Windows 还需要 PowerShell；推荐用 `pwsh`，没有时用系统自带 `powershell`。

4. 安装或启动。
   - macOS/Linux/Git Bash：运行 `scripts/agentfile-dev.sh <action>`。
   - Windows PowerShell：运行 `scripts/agentfile-dev.ps1 <action>`。
   - `<action>` 可用：`doctor`、`status`、`diagnose`、`install`、`run`、`build`、`update`、`reset-dev-data`。

5. 验证。
   - 看终端输出里是否出现 `waveterm2-dev`、`dev server running`。
   - 如果用户要你测试 UI，优先复用当前已启动的 Agentfile 窗口。
   - 如果已经运行，不要重复启动；直接用浏览器/Computer Use 检查现有开发版窗口和日志。

## 可用脚本

脚本路径相对本 skill 目录。macOS/Linux/Git Bash：

```bash
scripts/agentfile-dev.sh doctor
scripts/agentfile-dev.sh status
scripts/agentfile-dev.sh diagnose
scripts/agentfile-dev.sh install
scripts/agentfile-dev.sh run
scripts/agentfile-dev.sh build
scripts/agentfile-dev.sh update
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/agentfile-dev.ps1 doctor
powershell -ExecutionPolicy Bypass -File scripts/agentfile-dev.ps1 status
powershell -ExecutionPolicy Bypass -File scripts/agentfile-dev.ps1 diagnose
powershell -ExecutionPolicy Bypass -File scripts/agentfile-dev.ps1 install
powershell -ExecutionPolicy Bypass -File scripts/agentfile-dev.ps1 run
```

脚本可以接受环境变量：

```bash
AGENTFILE_REPO="$HOME/Desktop/Agentfile" scripts/agentfile-dev.sh run
AGENTFILE_REPO_URL="https://github.com/Ceeon/agentfile.git" scripts/agentfile-dev.sh install
AGENTFILE_CLONE_DEPTH=1 scripts/agentfile-dev.sh install
```

```powershell
$env:AGENTFILE_REPO = "$HOME\Desktop\Agentfile"
$env:AGENTFILE_REPO_URL = "https://github.com/Ceeon/agentfile.git"
$env:AGENTFILE_CLONE_DEPTH = "1"
powershell -ExecutionPolicy Bypass -File scripts/agentfile-dev.ps1 run
```

`AGENTFILE_CLONE_DEPTH=1` 是默认值，用于自部署时优先浅克隆，减少网络失败概率。需要完整历史时设为 `0`。

## 更新规则

用户说“更新 Agentfile”或“更新本地环境”时：

1. 先 `git status --short`。
2. 工作区干净才 `git pull --ff-only`。
3. 工作区不干净时停止，说明哪些文件有改动，让用户决定是否提交、暂存或另开目录。

## 诊断规则

- `status` 不应该修改项目，只报告当前状态。
- `diagnose` 可以运行 `npm run build:dev`，用于确认主进程、preload 和前端 bundle 是否能编译。
- 发现端口 `5173` 已可访问时，认为开发服务大概率已启动；不要再开第二个 dev server。
- 发现日志里有 `error`、`panic`、`failed`、`exception` 时，优先围绕最新日志定位。
- 修复代码后至少跑 `scripts/agentfile-dev.sh diagnose` 或平台对应 PowerShell 脚本；如果改动很小，至少跑 `build` 或相关测试。

## 禁止事项

- 不运行 `task package`，除非用户明确要求安装包。
- 不删除 `dist/`、`make/`，除非当前任务明确是重新打包。
- 不清空开发版数据目录，除非用户明确说要重置测试数据。
- 不把 `~/.config/waveterm2` 当成当前测试配置目录。
