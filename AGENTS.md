# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Agentfile is a customized fork of Wave Terminal (v0.13.2-alpha.0). It's an Electron-based terminal with a Go backend, featuring a block-based UI for terminals, file previews, and editors.

**Key customizations** (see AGENTFILE-CHANGELOG.md):
- VSCode-style tree file browser with drag-and-drop move
- Removed AI button from tab bar
- Block rename functionality
- Data isolation from original Wave (uses `waveterm2` directories)

## Project Skills

- `.claude/skills/agentfile-dev/SKILL.md` is the project-level skill for launching, diagnosing, validating, and fixing Agentfile.
- Use it when the user asks to start Agentfile, check whether it is running, debug startup/preload/main issues, or validate the local development environment.
- Treat `http://localhost:5173/` as the Electron renderer dev server only. Do not present it as a user-facing web page; the actual product surface is the Agentfile Electron window.
- Agentfile is treated as a continuously editable local app. Avoid user-facing release-channel labels unless the user explicitly asks about packaging or distribution.

## Build Commands

```bash
# Development (hot reload)
task dev

# Quick dev (arm64 macOS only, faster startup)
task electron:quickdev

# Run standalone (no dev server)
task start

# Build backend only (wavesrv + wsh)
task build:backend

# Build server only
task build:server

# Production package (creates DMG/installers)
task package

# Initialize dev environment
task init
```

**Important**: `task package` 会先执行 `clean` 删除 `dist/`，导致之前构建的 wavesrv 被清除。由于 task 的缓存机制，`build:server` 可能被判定为 "up to date" 而跳过重建。正确做法：
```bash
# 先手动清理，强制 task 重新构建
rm -rf dist make && task build:server && task package
```
**不要** 分开运行 `task build:server && task package`，因为 package 内部的 clean 会删掉刚构建好的二进制文件。

## Testing

```bash
npm run test      # Run tests (watch mode)
npm run coverage  # Run with coverage
```

Uses Vitest. Tests are colocated with source files.

## Architecture

### Stack
- **Frontend**: React 19 + TypeScript + Electron + Jotai (state) + Tailwind CSS
- **Backend**: Go (wavesrv binary)
- **Communication**: WebSocket JSON-RPC

### Directory Structure
```
frontend/app/       # React application
  ├── block/        # Block UI components
  ├── view/         # View renderers (terminal, preview, editor)
  ├── store/        # Jotai atoms + RPC client (wshclientapi.ts)
  └── modals/       # Modal dialogs

emain/              # Electron main process

cmd/                # Go entrypoints
  ├── server/       # wavesrv main
  └── wsh/          # Wave Shell Extensions

pkg/                # Go packages
  ├── wshrpc/       # RPC types and server
  ├── blockcontroller/  # Block lifecycle
  ├── shellexec/    # Shell process execution
  └── remote/       # SSH connections
```

### Frontend-Backend Communication

RPC commands flow through:
1. `frontend/app/store/wshclientapi.ts` - Auto-generated TypeScript API
2. WebSocket connection to wavesrv
3. `pkg/wshrpc/wshserver/` - Go RPC handlers

Key RPC patterns:
```typescript
// Read file
await RpcApi.FileReadCommand(TabRpcClient, { info: { path: "wsh://local/path" } }, null);

// Move file
await RpcApi.FileMoveCommand(TabRpcClient, { srcuri, desturi, opts }, null);
```

### State Management

Uses Jotai atoms in `frontend/app/store/global.ts`. Key patterns:
- `useAtomValue(atom)` - Read atom
- `useSetAtom(atom)` - Get setter
- `globalStore.get(atom)` / `globalStore.set(atom, value)` - Outside React

### Event System

Wave Pub/Sub (`pkg/wps/`) broadcasts events. Frontend subscribes via:
```typescript
waveEventSubscribe({
  eventType: "dirwatch",
  scope: `block:${blockId}`,
  handler: () => { /* refresh */ }
});
```

#### Directory Preview Refresh Model

- Local directory previews subscribe to backend `dirwatch` events. Remote directories do not have local `fsnotify`, so the frontend polls them every 2 seconds as a fallback.
- Backend directory watches are recursive and reference-counted per block. This matters when the same block opens both a parent directory and an expanded child directory: unsubscribing the child must not tear down the parent's recursive watch.
- Frontend auto-refresh is intentionally selective. `CREATE` / `REMOVE` / `RENAME` always refresh, but write-only events are ignored while sorting by `name` or `type` to avoid constant redraws during builds, logs, or repeated file writes.
- Expanded subdirectories refresh independently. Automatic updates should reload only the affected directory instead of re-reading the full expanded tree.
- Main implementation points:
  - `pkg/service/dirwatch/dirwatch.go`
  - `frontend/app/view/preview/preview-directory.tsx`
  - `frontend/util/directorywatchutil.ts`

## Code Patterns

### Adding RPC Commands

1. Define types in `pkg/wshrpc/wshrpctypes.go`
2. Implement handler in `pkg/wshrpc/wshserver/wshserver.go`
3. Run `task generate` to update TypeScript bindings

### Block Views

Views are in `frontend/app/view/`. Each view has:
- A model (`*-model.tsx`) with Jotai atoms
- A component (`*.tsx`) rendering the UI
- Registration in `frontend/app/view/viewregistry.ts`

### File URIs

Use `wsh://` protocol for file operations:
- `wsh://local/path` - Local filesystem
- `wsh://conn/user@host/path` - Remote via SSH

## Dev Environment Notes

- **Data**: `~/Library/Application Support/waveterm2-dev`
- **Logs**: `waveapp.log` in data directory

When dev server starts, set `WCLOUD_ENDPOINT` and `WCLOUD_WS_ENDPOINT` environment variables:
```bash
WCLOUD_ENDPOINT="https://api.waveterm.dev/central" WCLOUD_WS_ENDPOINT="wss://wsapi.waveterm.dev/" npm run dev
```

## Important: Testing Changes

**不要关闭用户正在使用的 Agentfile 应用！** 测试代码修改时：
1. 使用 `task dev` 启动 Agentfile（使用 waveterm2-dev 数据目录）
2. 不要关闭用户正在使用的 Agentfile 应用
3. 只有用户明确要求打包时，才执行 `task package`

## Data Persistence Patterns

Block 元数据 (`block.meta`) 随 block 生命周期存在——tab 关闭时 block 被删除，数据丢失。需要跨 tab/session 持久化的数据应存入 settings：

- **读取**: `globalStore.get(getSettingsKeyAtom("preview:bookmarks"))`
- **写入**: `RpcApi.SetConfigCommand(TabRpcClient, { "preview:bookmarks": value })`
- **Go 类型**: 在 `pkg/wconfig/settingsconfig.go` 的 `SettingsType` 中添加字段
- **生成 TS 类型**: `task generate`

添加新 settings 字段流程：
1. `pkg/wconfig/settingsconfig.go` → `SettingsType` 加字段（如 `PreviewBookmarks []any`）
2. `task generate` → 自动更新 `frontend/types/gotypes.d.ts`
3. 前端通过 `SetConfigCommand` 写入，数据保存到 `~/.config/waveterm2/settings.json`

注意：`SetBaseConfigValue` 会对 config key 做类型检查（`getConfigKeyType`），必须在 `SettingsType` 中声明字段后才能写入。复杂类型（数组/对象）用 `[]any` 避免 JSON 反序列化类型不匹配。

## User Preferences

- **自动执行**: 不要询问确认，直接执行操作（如打开 DMG、重启开发服务器等）
