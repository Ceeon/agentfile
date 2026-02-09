# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Wave 2 is a customized fork of Wave Terminal (v0.13.2-alpha.0). It's an Electron-based terminal with a Go backend, featuring a block-based UI for terminals, file previews, and editors.

**Key customizations** (see WAVE2-CHANGELOG.md):
- VSCode-style tree file browser with drag-and-drop move
- Removed AI button from tab bar
- Block rename functionality
- Data isolation from original Wave (uses `waveterm2` directories)

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

**Important**: `task package` runs `clean` first which deletes `dist/`. If packaging fails to include wavesrv, run `task build:server` before `task package`.

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

- **Dev data**: `~/Library/Application Support/waveterm2-dev`
- **Prod data**: `~/Library/Application Support/waveterm2`
- **Logs**: `waveapp.log` in data directory

When dev server starts, set `WCLOUD_ENDPOINT` and `WCLOUD_WS_ENDPOINT` environment variables:
```bash
WCLOUD_ENDPOINT="https://api.waveterm.dev/central" WCLOUD_WS_ENDPOINT="wss://wsapi.waveterm.dev/" npm run dev
```

## Important: Testing Changes

**不要关闭用户正在使用的 Wave 2 应用！** 测试代码修改时：
1. 使用 `task dev` 启动开发版本（使用 waveterm2-dev 数据目录）
2. 开发版和正式版可以同时运行，互不影响
3. 只有用户明确要求更新正式版时，才执行 `task package` 并安装

## User Preferences

- **自动执行**: 不要询问确认，直接执行操作（如打开 DMG、重启开发服务器等）
