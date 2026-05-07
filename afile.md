# afile

## 位置说明

当前代码仓库已经迁到：

- `/Users/chengfeng/Desktop/Agentfile`

这轮改动主要落在：

- `frontend/app/store/keymodel.ts`
- `frontend/app/block/blockframe-header.tsx`
- `frontend/app/view/preview/preview-directory.tsx`
- `frontend/app/view/preview/preview-model.tsx`
- `frontend/app/view/preview/preview-edit.tsx`
- `frontend/util/previewutil.ts`
- `frontend/util/directorycontextmenu.ts`

## 当前目标

在保留 Wave 骨架的前提下，收敛成一个以文件工作台为核心的轻量应用。

核心方向：

- 文件切换
- Markdown 直接编辑并实时写回文件
- 多标签页
- 远程文件工作流
- 外部终端作为动作，不作为主视图

## 已完成

- 去掉前台显式 `workspace` 概念，界面不再把它当成主概念暴露
- 目录右键菜单改成中文，并收敛重复入口
- 目录区去掉手动刷新按钮，默认自动刷新
- 本地目录走 watcher 自动刷新，远程目录保留轮询兜底
- 搜索改成小按钮展开，不常驻
- 恢复目录区 `新建文件` / `新建文件夹`
- `当前窗口打开`、回车打开、双击文件打开，统一改成默认在右侧分栏打开
- 文件夹右键打开语义已统一成三类：`当前窗口跳转`、`在当前标签页打开`、`在新标签页打开`
- 文件右键打开语义已统一成两类：`在当前标签页打开`、`在新标签页打开`
- 新标签页打开不再创建新 Electron 窗口，而是在当前窗口里创建新标签页
- Markdown 文件增加后缀兜底识别，`.md/.markdown/.mdx` 会稳定识别成文档文件
- Markdown 文件默认不再走左右双栏预览，而是直接进入文本编辑
- 文档编辑自动保存延迟已收紧到 `150ms`，更接近直接修改文件本体
- Markdown 默认字号已调回和主编辑区一致
- 标签页标题、顶部路径、文件树搜索与控制区字号已同步上调，避免文档区和周边 UI 看起来像两套比例
- 本地目录自动刷新已修正为按“是否本地连接”判断，不再把 `local` 误判成远程目录
- 目录工具栏的“刷新”按钮已恢复
- 目录工具栏已补上可见的“打开终端”按钮，文件头部也补了终端入口
- `Cmd+R` 现在会直接让当前标签页进入内联重命名；文件还原改成 `Cmd+Shift+R`
- 区块头部已去掉“放大区块”和“复制区块 ID”
- 大文件/不支持类型的错误提示已经改成“打开文件”语义，不再展示“预览”文案
- 旧的 Markdown 专用双栏预览链路已从主渲染入口移除，避免默认流程再绕回去

## 当前状态

最近一次确认：

- `npm install` 已重新执行
- `npm run build:dev` 已通过
- 菜单测试已通过：`previewutil.test.ts`、`directorycontextmenu.test.ts`

## 还没做完

- 目录预览形态还没有继续往更轻的文件工作台样式收
- 还需要继续清理 Wave 里与文件工作台无关的入口和残留概念
- 新手引导、帮助页和历史文案里还残留少量旧概念，需要继续清扫

## 下一步

优先顺序建议：

1. 继续削减非文件工作台入口
2. 继续收目录区和文档区的默认体验
3. 把界面里残留的 `预览` / `Preview` 可见文案继续清干净
4. 清理 onboarding / help / tips 里的旧叙述
5. 再做一轮完整联调
