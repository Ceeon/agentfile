# Agentfile 修改日志

基于 Wave Terminal v0.13.2-alpha.0 的定制版本。

---

## 主要改动

### 1. VSCode 风格树形文件浏览器

**文件**: `frontend/app/view/preview/preview-directory.tsx`

原版是扁平表格视图，改为树形视图：
- 点击箭头 `▶`/`▼` 展开/折叠目录
- 双击目录展开/折叠
- 双击文件在新 block 中打开预览
- 支持多级目录嵌套显示
- 目录优先排序（文件夹在前，文件在后）
- 懒加载子目录（点击展开时才加载）

### 2. 右键菜单增强

**文件**: `frontend/app/view/preview/preview-directory.tsx`

- 新增 **"Open Folder"** 选项（仅目录显示）
- 点击后导航进入该目录

### 3. 自动刷新支持

**文件**: `frontend/app/view/preview/preview-directory.tsx`

- 刷新时自动清除子目录缓存
- 展开的目录会重新加载最新内容

### 4. 文件拖放移动功能

**文件**:
- `frontend/app/view/preview/preview-directory.tsx`
- `frontend/app/view/preview/directorypreview.scss`

拖放功能：
- 支持拖动文件/文件夹到子目录
- 拖动执行**移动**操作（非复制）
- 目标文件已存在时弹出覆盖确认

视觉反馈：
- 拖动中的元素半透明 (opacity: 0.5)
- 有效放置目标显示高亮边框（虚线）
- 无效目标显示禁止光标

Bug 修复：
- 修复文件夹展开/关闭图标与实际状态不同步的问题

### 5. 移除 AI 入口

**文件**: `frontend/app/tab/tabbar.tsx`

- 删除左上角的 Wave AI 按钮

### 6. 应用重命名

**文件**: `package.json`

- `productName`: Wave → Agentfile
- `appId`: dev.commandline.waveterm → dev.ceeon.agentfile

### 7. Block 重命名功能

**文件**:
- `frontend/app/block/blockframe.tsx`
- `frontend/app/modals/renameblockmodal.tsx`（新建）
- `frontend/app/modals/modalregistry.tsx`

新增右键菜单选项：
- 右键点击 block 标题栏 → **"Rename Block"**
- 弹出模态框输入新名称
- 留空可恢复默认名称（如 "Terminal"）

---

### 8. 数据隔离（修复闪退问题）

**文件**: `emain/emain-platform.ts`

原版 Wave 和 Agentfile 共享同一个应用名和单实例锁，导致 Agentfile 无法启动。修改：

- `app.setName("waveterm/electron")` → `app.setName("waveterm2/electron")`
- `app.setName("Wave")` → `app.setName("Agentfile")`（生产模式）
- `waveDirNamePrefix = "waveterm"` → `waveDirNamePrefix = "waveterm2"`
- `envPaths("waveterm", ...)` → `envPaths("waveterm2", ...)`

这确保 Agentfile 有独立的：
- 单实例锁
- 数据目录
- 配置目录

---

## 样式修改

**文件**: `frontend/app/view/preview/directorypreview.scss`

新增 `.dir-tree` 样式：
- 行高紧凑
- 层级缩进 16px/级
- 悬停高亮
- 选中状态样式

---

## 构建命令

```bash
# 开发模式
task dev

# 独立运行
task start

# 打包
task package
```

---

## 数据目录

Agentfile 与原版 Wave 完全独立运行，互不影响：

| 版本 | 数据目录 |
|-----|---------|
| Wave 原版 | `~/Library/Application Support/waveterm` |
| Agentfile 正式版 | `~/Library/Application Support/waveterm2` |
| Agentfile 开发版 | `~/Library/Application Support/waveterm2-dev` |

---

*修改日期: 2026-02-04*
*基于: Wave Terminal v0.13.2-alpha.0*
