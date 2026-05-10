// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    getApi,
    getConnStatusAtom,
    getOverrideConfigAtom,
    getSettingsKeyAtom,
    globalStore,
    refocusNode,
} from "@/store/global";
import * as services from "@/store/services";
import * as WOS from "@/store/wos";
import { goHistory, goHistoryBack, goHistoryForward } from "@/util/historyutil";
import { checkKeyPressed } from "@/util/keyutil";
import { base64ToString, fireAndForget, isBlank, isLocalConnName, jotaiLoadableValue, stringToBase64 } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import clsx from "clsx";
import { Atom, atom, Getter, PrimitiveAtom, WritableAtom } from "jotai";
import { loadable } from "jotai/utils";
import type * as MonacoTypes from "monaco-editor";
import { createRef } from "react";
import { PreviewView } from "./preview";

// Bookmark type for directory quick navigation
type BookmarkItem = { label: string; path: string };

// Default bookmarks that are always available
const DEFAULT_BOOKMARKS: BookmarkItem[] = [
    { label: "主目录", path: "~" },
    { label: "桌面", path: "~/Desktop" },
    { label: "下载", path: "~/Downloads" },
    { label: "文稿", path: "~/Documents" },
    { label: "根目录", path: "/" },
];

function makeDirectoryBookmarkLabel(path: string): string {
    const normalized = path.replace(/\/+$/, "");
    if (normalized === "") {
        return path || "目录";
    }
    return normalized.split("/").filter(Boolean).pop() || normalized;
}

const MaxFileSize = 1024 * 1024 * 10; // 10MB
const MaxCSVSize = 1024 * 1024 * 1; // 1MB
const SelfWriteRefreshIgnoreMs = 1500;

type PreviewStateCarrier = {
    editorViewStates?: Map<string, MonacoTypes.editor.ICodeEditorViewState | null>;
    lastEditorViewState?: MonacoTypes.editor.ICodeEditorViewState | null;
    previewScrollTops?: Map<string, number>;
    lastPreviewScrollTop?: number;
};

const textApplicationMimetypes = [
    "application/sql",
    "application/x-php",
    "application/x-pem-file",
    "application/x-httpd-php",
    "application/liquid",
    "application/graphql",
    "application/javascript",
    "application/typescript",
    "application/x-javascript",
    "application/x-typescript",
    "application/dart",
    "application/vnd.dart",
    "application/x-ruby",
    "application/sql",
    "application/wasm",
    "application/x-latex",
    "application/x-sh",
    "application/x-python",
    "application/x-awk",
];

function isTextFile(mimeType: string): boolean {
    if (mimeType == null) {
        return false;
    }
    return (
        mimeType.startsWith("text/") ||
        textApplicationMimetypes.includes(mimeType) ||
        (mimeType.startsWith("application/") &&
            (mimeType.includes("json") || mimeType.includes("yaml") || mimeType.includes("toml"))) ||
        mimeType.includes("xml")
    );
}

function normalizePreviewStatePath(path?: string | null): string {
    if (isBlank(path)) {
        return "";
    }
    return String(path).replace(/\\/g, "/");
}

function ensurePreviewStateCarrier(model: PreviewStateCarrier): Required<PreviewStateCarrier> {
    if (!(model.editorViewStates instanceof Map)) {
        model.editorViewStates = new Map();
    }
    if (!(model.previewScrollTops instanceof Map)) {
        model.previewScrollTops = new Map();
    }
    if (model.lastEditorViewState === undefined) {
        model.lastEditorViewState = null;
    }
    if (typeof model.lastPreviewScrollTop !== "number") {
        model.lastPreviewScrollTop = 0;
    }
    return model as Required<PreviewStateCarrier>;
}

export function getPreviewModelEditorViewState(
    model: PreviewStateCarrier,
    path?: string | null
): MonacoTypes.editor.ICodeEditorViewState | null {
    const carrier = ensurePreviewStateCarrier(model);
    const normalizedPath = normalizePreviewStatePath(path);
    if (normalizedPath && carrier.editorViewStates.has(normalizedPath)) {
        return carrier.editorViewStates.get(normalizedPath) ?? null;
    }
    return carrier.lastEditorViewState;
}

export function setPreviewModelEditorViewState(
    model: PreviewStateCarrier,
    path: string | null | undefined,
    viewState: MonacoTypes.editor.ICodeEditorViewState | null
) {
    const carrier = ensurePreviewStateCarrier(model);
    const normalizedPath = normalizePreviewStatePath(path);
    carrier.lastEditorViewState = viewState;
    if (!normalizedPath) {
        return;
    }
    carrier.editorViewStates.set(normalizedPath, viewState);
}

export function getPreviewModelScrollTop(model: PreviewStateCarrier, path?: string | null): number {
    const carrier = ensurePreviewStateCarrier(model);
    const normalizedPath = normalizePreviewStatePath(path);
    if (normalizedPath && carrier.previewScrollTops.has(normalizedPath)) {
        return carrier.previewScrollTops.get(normalizedPath) ?? 0;
    }
    return carrier.lastPreviewScrollTop;
}

export function setPreviewModelScrollTop(model: PreviewStateCarrier, path: string | null | undefined, scrollTop: number) {
    if (!Number.isFinite(scrollTop)) {
        return;
    }
    const carrier = ensurePreviewStateCarrier(model);
    const normalizedPath = normalizePreviewStatePath(path);
    carrier.lastPreviewScrollTop = scrollTop;
    if (!normalizedPath) {
        return;
    }
    carrier.previewScrollTops.set(normalizedPath, scrollTop);
}

function isStreamingType(mimeType: string): boolean {
    if (mimeType == null) {
        return false;
    }
    return (
        mimeType.startsWith("application/pdf") ||
        mimeType.startsWith("video/") ||
        mimeType.startsWith("audio/") ||
        mimeType.startsWith("image/")
    );
}

function isMarkdownLike(mimeType: string): boolean {
    if (mimeType == null) {
        return false;
    }
    const normalizedMimeType = mimeType.toLowerCase();
    return normalizedMimeType.includes("markdown") || normalizedMimeType.includes("mdx");
}

function isHtmlLike(mimeType: string): boolean {
    if (mimeType == null) {
        return false;
    }
    const normalizedMimeType = mimeType.toLowerCase().split(";")[0].trim();
    return normalizedMimeType === "text/html" || normalizedMimeType === "application/xhtml+xml";
}

function inferMarkdownMimeType(fileInfo: FileInfo): string | null {
    const filePath = (fileInfo?.path ?? fileInfo?.name ?? "").toLowerCase();
    if (!filePath) {
        return null;
    }
    if (filePath.endsWith(".mdx")) {
        return "text/mdx";
    }
    if (
        filePath.endsWith(".md") ||
        filePath.endsWith(".markdown") ||
        filePath.endsWith(".mdown") ||
        filePath.endsWith(".mkd") ||
        filePath.endsWith(".mdtxt")
    ) {
        return "text/markdown";
    }
    return null;
}

function isEditablePreviewView(view: string): boolean {
    return view === "codeedit";
}

function iconForFile(mimeType: string): string {
    if (mimeType == null) {
        mimeType = "unknown";
    }
    if (mimeType == "application/pdf") {
        return "file-pdf";
    } else if (mimeType.startsWith("image/")) {
        return "image";
    } else if (mimeType.startsWith("video/")) {
        return "film";
    } else if (mimeType.startsWith("audio/")) {
        return "headphones";
    } else if (isMarkdownLike(mimeType)) {
        return "file-lines";
    } else if (isHtmlLike(mimeType)) {
        return "file-code";
    } else if (mimeType == "text/csv") {
        return "file-csv";
    } else if (
        mimeType.startsWith("text/") ||
        mimeType == "application/sql" ||
        (mimeType.startsWith("application/") &&
            (mimeType.includes("json") || mimeType.includes("yaml") || mimeType.includes("toml")))
    ) {
        return "file-code";
    } else {
        return "file";
    }
}

export class PreviewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    noPadding?: Atom<boolean>;
    blockAtom: Atom<Block>;
    viewIcon: Atom<string | IconButtonDecl>;
    viewName: Atom<string>;
    viewText: Atom<HeaderElem[]>;
    preIconButton: Atom<IconButtonDecl>;
    endIconButtons: Atom<IconButtonDecl[]>;
    hideViewName: Atom<boolean>;
    previewTextRef: React.RefObject<HTMLDivElement>;
    pathInputRef: React.RefObject<HTMLInputElement>;
    editMode: Atom<boolean>;
    canPreview: PrimitiveAtom<boolean>;
    specializedView: Atom<Promise<{ specializedView?: string; errorStr?: string }>>;
    loadableSpecializedView: Atom<Loadable<{ specializedView?: string; errorStr?: string }>>;
    manageConnection: Atom<boolean>;
    connStatus: Atom<ConnStatus>;
    filterOutNowsh?: Atom<boolean>;

    metaFilePath: Atom<string>;
    statFilePath: Atom<Promise<string>>;
    loadableFileInfo: Atom<Loadable<FileInfo>>;
    connection: Atom<Promise<string>>;
    connectionImmediate: Atom<string>;
    statFile: Atom<Promise<FileInfo>>;
    fullFile: Atom<Promise<FileData>>;
    fileMimeType: Atom<Promise<string>>;
    fileMimeTypeLoadable: Atom<Loadable<string>>;
    fileContentSaved: PrimitiveAtom<string | null>;
    fileContent: WritableAtom<Promise<string>, [string], void>;
    newFileContent: PrimitiveAtom<string | null>;
    saveLoopPromise: Promise<void> | null;
    queuedSaveContent: string | null;
    fileRefreshPromise: Promise<void> | null;
    recentSelfWrite: { dirPath: string; fileName: string; filePath: string; expiresAt: number } | null;
    connectionError: PrimitiveAtom<string>;
    errorMsgAtom: PrimitiveAtom<ErrorMsg>;

    openFileModal: PrimitiveAtom<boolean>;
    openFileModalDelay: PrimitiveAtom<boolean>;
    openFileError: PrimitiveAtom<string>;
    openFileModalGiveFocusRef: React.RefObject<() => boolean>;
    pathEditMode: PrimitiveAtom<boolean>;
    pathEditValue: PrimitiveAtom<string>;

    monacoRef: React.RefObject<MonacoTypes.editor.IStandaloneCodeEditor>;
    editorViewStates: Map<string, MonacoTypes.editor.ICodeEditorViewState | null>;
    lastEditorViewState: MonacoTypes.editor.ICodeEditorViewState | null;
    previewScrollTops: Map<string, number>;
    lastPreviewScrollTop: number;

    showHiddenFiles: PrimitiveAtom<boolean>;
    refreshVersion: PrimitiveAtom<number>;
    refreshCallback: () => void;
    directoryKeyDownHandler: (waveEvent: WaveKeyboardEvent) => boolean;
    codeEditKeyDownHandler: (waveEvent: WaveKeyboardEvent) => boolean;

    constructor(blockId: string, nodeModel: BlockNodeModel, tabModel: TabModel) {
        this.viewType = "preview";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        let showHiddenFiles = globalStore.get(getSettingsKeyAtom("preview:showhiddenfiles")) ?? true;
        this.showHiddenFiles = atom<boolean>(showHiddenFiles);
        this.refreshVersion = atom(0);
        this.previewTextRef = createRef();
        this.pathInputRef = createRef();
        this.openFileModal = atom(false);
        this.openFileModalDelay = atom(false);
        this.openFileError = atom(null) as PrimitiveAtom<string>;
        this.openFileModalGiveFocusRef = createRef();
        this.pathEditMode = atom(false);
        this.pathEditValue = atom("");
        this.manageConnection = atom(true);
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.filterOutNowsh = atom(true);
        this.monacoRef = createRef();
        this.editorViewStates = new Map();
        this.lastEditorViewState = null;
        this.previewScrollTops = new Map();
        this.lastPreviewScrollTop = 0;
        this.connectionError = atom("");
        this.errorMsgAtom = atom(null) as PrimitiveAtom<ErrorMsg | null>;
        this.triggerRefresh = this.triggerRefresh.bind(this);
        this.viewIcon = atom((get) => {
            const blockData = get(this.blockAtom);
            if (blockData?.meta?.icon) {
                return blockData.meta.icon;
            }
            const connStatus = get(this.connStatus);
            if (connStatus?.status != "connected") {
                return null;
            }
            const mimeTypeLoadable = get(this.fileMimeTypeLoadable);
            const mimeType = jotaiLoadableValue(mimeTypeLoadable, "");
            if (mimeType == "directory") {
                return {
                    elemtype: "iconbutton",
                    icon: "folder-open",
                    click: (e: React.MouseEvent<any>) => {
                        const loadableFileInfo = get(this.loadableFileInfo);
                        const currentPath =
                            (loadableFileInfo.state == "hasData" ? loadableFileInfo.data?.path : get(this.metaFilePath)) ?? "";
                        if (isBlank(currentPath)) {
                            return;
                        }
                        const connection = get(this.connectionImmediate);
                        const customBookmarks = this.getCustomBookmarks();
                        const menuItems: ContextMenuItem[] = [
                            {
                                label: "复制路径",
                                click: () => getApi().writeClipboardText(currentPath),
                            },
                        ];
                        if (!isLocalConnName(connection)) {
                            menuItems.push({
                                label: "复制远程 URI",
                                click: () => getApi().writeClipboardText(formatRemoteUri(currentPath, connection)),
                            });
                        }
                        menuItems.push({ type: "separator" });
                        if (isLocalConnName(connection)) {
                            menuItems.push({
                                label: "在 Finder 中打开",
                                click: () => getApi().openDirectoryTarget("finder", currentPath, connection),
                            });
                        }
                        menuItems.push({
                            label: "在终端中打开",
                            click: () => getApi().openDirectoryTarget("terminal", currentPath, connection),
                        });
                        menuItems.push({
                            label: "添加到书签",
                            click: () =>
                                fireAndForget(() => this.addBookmark(currentPath, makeDirectoryBookmarkLabel(currentPath))),
                        });

                        // Add default bookmarks section
                        menuItems.push({ type: "separator" });
                        for (const bookmark of DEFAULT_BOOKMARKS) {
                            menuItems.push({
                                label: `${bookmark.label} (${bookmark.path})`,
                                click: () => this.goHistory(bookmark.path),
                            });
                        }

                        // Add custom bookmarks section if any exist
                        if (customBookmarks.length > 0) {
                            menuItems.push({ type: "separator" });
                            for (const bookmark of customBookmarks) {
                                menuItems.push({
                                    label: `${bookmark.label} (${bookmark.path})`,
                                    click: () => this.goHistory(bookmark.path),
                                    submenu: [
                                        {
                                            label: "前往",
                                            click: () => this.goHistory(bookmark.path),
                                        },
                                        {
                                            label: "移除书签",
                                            click: () => fireAndForget(() => this.removeBookmark(bookmark.path)),
                                        },
                                    ],
                                });
                            }
                        }

                        ContextMenuModel.showContextMenu(menuItems, e);
                    },
                };
            }
            return iconForFile(mimeType);
        });
        this.editMode = atom((get) => {
            const blockData = get(this.blockAtom);
            return blockData?.meta?.edit ?? false;
        });
        this.viewName = atom("文件");
        this.hideViewName = atom(true);
        this.viewText = atom((get) => {
            let headerPath = get(this.metaFilePath);
            const connStatus = get(this.connStatus);
            if (connStatus?.status != "connected") {
                return [
                    {
                        elemtype: "text",
                        text: headerPath,
                        className: "preview-filename",
                    },
                ];
            }
            const loadableSV = get(this.loadableSpecializedView);
            const currentView = loadableSV.state == "hasData" ? loadableSV.data.specializedView : null;
            const isEditingView = isEditablePreviewView(currentView);
            const mimeType = jotaiLoadableValue(get(this.fileMimeTypeLoadable), "");
            const isMarkdownFile = isMarkdownLike(mimeType);
            const canPreview = get(this.canPreview);
            const loadableFileInfo = get(this.loadableFileInfo);
            if (loadableFileInfo.state == "hasData") {
                headerPath = loadableFileInfo.data?.path;
                if (headerPath == "~") {
                    headerPath = `~ (${loadableFileInfo.data?.dir + "/" + loadableFileInfo.data?.name})`;
                }
            }
            if (!isBlank(headerPath) && headerPath != "/" && headerPath.endsWith("/")) {
                headerPath = headerPath.slice(0, -1);
            }
            const isPathEditing = get(this.pathEditMode);
            const pathEditValue = get(this.pathEditValue);
            const editablePathValue = get(this.metaFilePath) ?? headerPath ?? "";
            const viewTextChildren: HeaderElem[] = [
                isPathEditing
                    ? {
                          elemtype: "input",
                          value: pathEditValue,
                          ref: this.pathInputRef,
                          className: "preview-filename",
                          autoFocus: true,
                          autoSelect: true,
                          onChange: (e) => globalStore.set(this.pathEditValue, e.target.value),
                          onKeyDown: (e) => {
                              e.stopPropagation();
                              if (e.key === "Enter") {
                                  e.preventDefault();
                                  fireAndForget(this.commitPathEdit.bind(this));
                              } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  this.cancelPathEdit();
                                  refocusNode(this.blockId);
                              }
                          },
                          onBlur: () => this.cancelPathEdit(),
                      }
                    : {
                          elemtype: "text",
                          text: headerPath,
                          ref: this.previewTextRef,
                          className: "preview-filename",
                          onClick: () => this.beginPathEdit(editablePathValue),
                      },
            ];
            if (isEditingView) {
                const fileInfo = globalStore.get(this.loadableFileInfo);
                if (fileInfo.state != "hasData") {
                    viewTextChildren.push({
                        elemtype: "textbutton",
                        text: "加载中...",
                        className: clsx(`grey rounded-[4px] !py-[2px] !px-[10px] text-[11px] font-[500]`),
                        onClick: () => {},
                    });
                } else if (fileInfo.data.readonly) {
                    viewTextChildren.push({
                        elemtype: "textbutton",
                        text: "只读",
                        className: clsx(`yellow rounded-[4px] !py-[2px] !px-[10px] text-[11px] font-[500]`),
                        onClick: () => {},
                    });
                }
                if (canPreview) {
                    viewTextChildren.push({
                        elemtype: "textbutton",
                        text: isMarkdownFile ? "预览" : "查看",
                        className: "grey rounded-[4px] !py-[2px] !px-[10px] text-[11px] font-[500]",
                        onClick: () => fireAndForget(() => this.setEditMode(false)),
                    });
                }
            }
            if (!isEditingView && canPreview) {
                viewTextChildren.push({
                    elemtype: "textbutton",
                    text: "编辑",
                    className: "grey rounded-[4px] !py-[2px] !px-[10px] text-[11px] font-[500]",
                    onClick: () => fireAndForget(() => this.setEditMode(true)),
                });
            }
            return [
                {
                    elemtype: "div",
                    children: viewTextChildren,
                },
            ] as HeaderElem[];
        });
        this.preIconButton = atom((get) => {
            const connStatus = get(this.connStatus);
            if (connStatus?.status != "connected") {
                return null;
            }
            const mimeType = jotaiLoadableValue(get(this.fileMimeTypeLoadable), "");
            const metaPath = get(this.metaFilePath);
            if (mimeType == "directory" && metaPath == "/") {
                return null;
            }
            return {
                elemtype: "iconbutton",
                icon: "chevron-left",
                click: this.goParentDirectory.bind(this),
            };
        });
        this.endIconButtons = atom((get) => {
            const connStatus = get(this.connStatus);
            if (connStatus?.status != "connected") {
                return null;
            }
            return null;
        });
        this.metaFilePath = atom<string>((get) => {
            const file = get(this.blockAtom)?.meta?.file;
            if (isBlank(file)) {
                return "~";
            }
            return file;
        });
        this.statFilePath = atom<Promise<string>>(async (get) => {
            const fileInfo = await get(this.statFile);
            return fileInfo?.path;
        });
        this.connection = atom<Promise<string>>(async (get) => {
            const connName = get(this.blockAtom)?.meta?.connection;
            try {
                await RpcApi.ConnEnsureCommand(TabRpcClient, { connname: connName }, { timeout: 60000 });
                globalStore.set(this.connectionError, "");
            } catch (e) {
                globalStore.set(this.connectionError, e as string);
            }
            return connName;
        });
        this.connectionImmediate = atom<string>((get) => {
            return get(this.blockAtom)?.meta?.connection;
        });
        this.statFile = atom<Promise<FileInfo>>(async (get) => {
            const fileName = get(this.metaFilePath);
            const path = await this.formatRemoteUri(fileName, get);
            if (fileName == null) {
                return null;
            }
            try {
                const statFile = await RpcApi.FileInfoCommand(TabRpcClient, {
                    info: {
                        path,
                    },
                });
                return statFile;
            } catch (e) {
                const errorStatus: ErrorMsg = {
                    status: "文件读取失败",
                    text: `${e}`,
                };
                globalStore.set(this.errorMsgAtom, errorStatus);
            }
        });
        this.fileMimeType = atom<Promise<string>>(async (get) => {
            const fileInfo = await get(this.statFile);
            const inferredMarkdownMimeType = inferMarkdownMimeType(fileInfo);
            if (inferredMarkdownMimeType) {
                return inferredMarkdownMimeType;
            }
            return fileInfo?.mimetype;
        });
        this.fileMimeTypeLoadable = loadable(this.fileMimeType);
        this.newFileContent = atom(null) as PrimitiveAtom<string | null>;
        this.goParentDirectory = this.goParentDirectory.bind(this);

        const fullFileAtom = atom<Promise<FileData>>(async (get) => {
            get(this.refreshVersion); // Subscribe to refreshVersion to trigger re-fetch
            const fileName = get(this.metaFilePath);
            const path = await this.formatRemoteUri(fileName, get);
            if (fileName == null) {
                return null;
            }
            try {
                const file = await RpcApi.FileReadCommand(TabRpcClient, {
                    info: {
                        path,
                    },
                });
                return file;
            } catch (e) {
                const errorStatus: ErrorMsg = {
                    status: "文件读取失败",
                    text: `${e}`,
                };
                globalStore.set(this.errorMsgAtom, errorStatus);
            }
        });

        this.fileContentSaved = atom(null) as PrimitiveAtom<string | null>;
        const fileContentAtom = atom(
            async (get) => {
                const newContent = get(this.newFileContent);
                if (newContent != null) {
                    return newContent;
                }
                const savedContent = get(this.fileContentSaved);
                if (savedContent != null) {
                    return savedContent;
                }
                const fullFile = await get(fullFileAtom);
                return base64ToString(fullFile?.data64);
            },
            (_, set, update: string) => {
                set(this.fileContentSaved, update);
            }
        );

        this.fullFile = fullFileAtom;
        this.fileContent = fileContentAtom;

        this.specializedView = atom<Promise<{ specializedView?: string; errorStr?: string }>>(async (get) => {
            return this.getSpecializedView(get);
        });
        this.loadableSpecializedView = loadable(this.specializedView);
        this.canPreview = atom(false);
        this.loadableFileInfo = loadable(this.statFile);
        this.connStatus = atom((get) => {
            const blockData = get(this.blockAtom);
            const connName = blockData?.meta?.connection;
            const connAtom = getConnStatusAtom(connName);
            return get(connAtom);
        });
        this.saveLoopPromise = null;
        this.queuedSaveContent = null;
        this.fileRefreshPromise = null;
        this.recentSelfWrite = null;

        this.noPadding = atom(true);
    }

    private normalizeWatchPath(path: string): string {
        return path.replace(/\\/g, "/");
    }

    private splitPathParts(path: string): { dirPath: string; fileName: string } {
        const normalizedPath = this.normalizeWatchPath(path);
        const lastSlashIdx = normalizedPath.lastIndexOf("/");
        if (lastSlashIdx < 0) {
            return { dirPath: ".", fileName: normalizedPath };
        }
        if (lastSlashIdx === 0) {
            return { dirPath: "/", fileName: normalizedPath.slice(1) };
        }
        return {
            dirPath: normalizedPath.slice(0, lastSlashIdx),
            fileName: normalizedPath.slice(lastSlashIdx + 1),
        };
    }

    private normalizeViewStatePath(path?: string | null): string {
        return isBlank(path) ? "" : this.normalizeWatchPath(path);
    }

    getEditorViewState(path?: string | null): MonacoTypes.editor.ICodeEditorViewState | null {
        const normalizedPath = this.normalizeViewStatePath(path);
        if (normalizedPath && this.editorViewStates.has(normalizedPath)) {
            return this.editorViewStates.get(normalizedPath) ?? null;
        }
        return this.lastEditorViewState;
    }

    setEditorViewState(path: string | null | undefined, viewState: MonacoTypes.editor.ICodeEditorViewState | null) {
        const normalizedPath = this.normalizeViewStatePath(path);
        this.lastEditorViewState = viewState;
        if (!normalizedPath) {
            return;
        }
        this.editorViewStates.set(normalizedPath, viewState);
    }

    getPreviewScrollTop(path?: string | null): number {
        const normalizedPath = this.normalizeViewStatePath(path);
        if (normalizedPath && this.previewScrollTops.has(normalizedPath)) {
            return this.previewScrollTops.get(normalizedPath) ?? 0;
        }
        return this.lastPreviewScrollTop;
    }

    setPreviewScrollTop(path: string | null | undefined, scrollTop: number) {
        if (!Number.isFinite(scrollTop)) {
            return;
        }
        const normalizedPath = this.normalizeViewStatePath(path);
        this.lastPreviewScrollTop = scrollTop;
        if (!normalizedPath) {
            return;
        }
        this.previewScrollTops.set(normalizedPath, scrollTop);
    }

    markSelfWrite(dirPath: string, fileName: string) {
        const normalizedDirPath = this.normalizeWatchPath(dirPath);
        const normalizedFilePath = this.normalizeWatchPath(
            dirPath === "/" ? `/${fileName}` : `${dirPath.replace(/\/+$/, "")}/${fileName}`
        );
        this.recentSelfWrite = {
            dirPath: normalizedDirPath,
            fileName,
            filePath: normalizedFilePath,
            expiresAt: Date.now() + SelfWriteRefreshIgnoreMs,
        };
    }

    shouldIgnoreOwnFileRefresh(filePath?: string | null): boolean {
        if (!filePath || this.recentSelfWrite == null) {
            return false;
        }
        if (this.recentSelfWrite.expiresAt <= Date.now()) {
            this.recentSelfWrite = null;
            return false;
        }
        return this.recentSelfWrite.filePath === this.normalizeWatchPath(filePath);
    }

    shouldIgnoreOwnFileWatchEvent(dirPath?: string, fileName?: string): boolean {
        if (!dirPath || !fileName || this.recentSelfWrite == null) {
            return false;
        }
        if (this.recentSelfWrite.expiresAt <= Date.now()) {
            this.recentSelfWrite = null;
            return false;
        }
        return (
            this.recentSelfWrite.dirPath === this.normalizeWatchPath(dirPath) &&
            this.recentSelfWrite.fileName === fileName
        );
    }

    // Get all bookmarks (default + custom)
    getBookmarks(): BookmarkItem[] {
        const customBookmarks = this.getCustomBookmarks();
        return [...DEFAULT_BOOKMARKS, ...customBookmarks];
    }

    // Get custom bookmarks from global settings (persists across blocks/tabs/sessions)
    getCustomBookmarks(): BookmarkItem[] {
        const settings = globalStore.get(getSettingsKeyAtom("preview:bookmarks"));
        return (settings as BookmarkItem[]) ?? [];
    }

    // Add a new custom bookmark (saved to settings file)
    async addBookmark(path: string, label: string): Promise<void> {
        const bookmarks = this.getCustomBookmarks();
        if (bookmarks.some((b) => b.path === path)) {
            return;
        }
        const newBookmarks = [...bookmarks, { label, path }];
        await RpcApi.SetConfigCommand(TabRpcClient, { "preview:bookmarks": newBookmarks });
    }

    // Remove a custom bookmark by path (saved to settings file)
    async removeBookmark(path: string): Promise<void> {
        const bookmarks = this.getCustomBookmarks();
        const newBookmarks = bookmarks.filter((b) => b.path !== path);
        await RpcApi.SetConfigCommand(TabRpcClient, {
            "preview:bookmarks": newBookmarks.length > 0 ? newBookmarks : null,
        });
    }

    get viewComponent(): ViewComponent {
        return PreviewView;
    }

    async getSpecializedView(getFn: Getter): Promise<{ specializedView?: string; errorStr?: string }> {
        const mimeType = await getFn(this.fileMimeType);
        const fileInfo = await getFn(this.statFile);
        const fileName = fileInfo?.name;
        const connErr = getFn(this.connectionError);
        const editMode = getFn(this.editMode);
        const genErr = getFn(this.errorMsgAtom);

        if (!fileInfo) {
            return { errorStr: `加载错误：${genErr?.text}` };
        }
        if (connErr != "") {
            return { errorStr: `连接错误：${connErr}` };
        }
        if (fileInfo?.notfound) {
            return { specializedView: "codeedit" };
        }
        if (mimeType == null) {
            return { errorStr: `无法确定文件类型：${fileInfo.path}` };
        }
        if (isStreamingType(mimeType)) {
            return { specializedView: "streaming" };
        }
        if (!fileInfo) {
            const fileNameStr = fileName ? " " + JSON.stringify(fileName) : "";
            return { errorStr: "文件不存在" + fileNameStr };
        }
        if (fileInfo.size > MaxFileSize) {
            return { errorStr: "文件过大，无法打开（最大 10 MB）" };
        }
        if (mimeType == "text/csv" && fileInfo.size > MaxCSVSize) {
            return { errorStr: "CSV 文件过大，无法打开（最大 1 MB）" };
        }
        if (mimeType == "directory") {
            return { specializedView: "directory" };
        }
        if (mimeType == "text/csv") {
            if (editMode) {
                return { specializedView: "codeedit" };
            }
            return { specializedView: "csv" };
        }
        if (isMarkdownLike(mimeType)) {
            if (editMode) {
                return { specializedView: "codeedit" };
            }
            return { specializedView: "markdown" };
        }
        if (isHtmlLike(mimeType)) {
            if (editMode) {
                return { specializedView: "codeedit" };
            }
            return { specializedView: "html" };
        }
        if (isTextFile(mimeType) || fileInfo.size == 0) {
            return { specializedView: "codeedit" };
        }
        return { errorStr: `暂不支持打开该文件类型（${mimeType}）` };
    }

    updateOpenFileModalAndError(isOpen, errorMsg = null) {
        globalStore.set(this.openFileModal, isOpen);
        globalStore.set(this.openFileError, errorMsg);
        if (isOpen) {
            globalStore.set(this.openFileModalDelay, true);
        } else {
            const delayVal = globalStore.get(this.openFileModalDelay);
            if (delayVal) {
                setTimeout(() => {
                    globalStore.set(this.openFileModalDelay, false);
                }, 200);
            }
        }
    }

    toggleOpenFileModal() {
        const modalOpen = globalStore.get(this.openFileModal);
        const delayVal = globalStore.get(this.openFileModalDelay);
        if (!modalOpen && delayVal) {
            return;
        }
        this.updateOpenFileModalAndError(!modalOpen);
    }

    beginPathEdit(initialPath?: string) {
        globalStore.set(this.pathEditValue, initialPath ?? globalStore.get(this.metaFilePath) ?? "");
        globalStore.set(this.pathEditMode, true);
    }

    cancelPathEdit() {
        globalStore.set(this.pathEditMode, false);
    }

    async commitPathEdit() {
        const nextPath = globalStore.get(this.pathEditValue)?.trim();
        this.cancelPathEdit();
        if (isBlank(nextPath)) {
            refocusNode(this.blockId);
            return;
        }
        await this.goHistory(nextPath);
        refocusNode(this.blockId);
    }

    async goHistory(newPath: string) {
        let fileName = globalStore.get(this.metaFilePath);
        if (fileName == null) {
            fileName = "";
        }
        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const updateMeta = goHistory("file", fileName, newPath, blockMeta);
        if (updateMeta == null) {
            return;
        }
        const blockOref = WOS.makeORef("block", this.blockId);
        await services.ObjectService.UpdateObjectMeta(blockOref, updateMeta);

        // Clear the saved file buffers
        globalStore.set(this.fileContentSaved, null);
        globalStore.set(this.newFileContent, null);
    }

    async goParentDirectory({ fileInfo = null }: { fileInfo?: FileInfo | null }) {
        // optional parameter needed for recursive case
        const defaultFileInfo = await globalStore.get(this.statFile);
        if (fileInfo === null) {
            fileInfo = defaultFileInfo;
        }
        if (fileInfo == null) {
            this.updateOpenFileModalAndError(false);
            return true;
        }
        try {
            this.updateOpenFileModalAndError(false);
            await this.goHistory(fileInfo.dir);
            refocusNode(this.blockId);
        } catch (e) {
            globalStore.set(this.openFileError, e.message);
            console.error("Error opening file", fileInfo.dir, e);
        }
    }

    async goHistoryBack() {
        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const curPath = globalStore.get(this.metaFilePath);
        const updateMeta = goHistoryBack("file", curPath, blockMeta, true);
        if (updateMeta == null) {
            return;
        }
        updateMeta.edit = false;
        const blockOref = WOS.makeORef("block", this.blockId);
        await services.ObjectService.UpdateObjectMeta(blockOref, updateMeta);
    }

    async goHistoryForward() {
        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const curPath = globalStore.get(this.metaFilePath);
        const updateMeta = goHistoryForward("file", curPath, blockMeta);
        if (updateMeta == null) {
            return;
        }
        updateMeta.edit = false;
        const blockOref = WOS.makeORef("block", this.blockId);
        await services.ObjectService.UpdateObjectMeta(blockOref, updateMeta);
    }

    async setEditMode(edit: boolean) {
        const blockMeta = globalStore.get(this.blockAtom)?.meta;
        const blockOref = WOS.makeORef("block", this.blockId);
        await services.ObjectService.UpdateObjectMeta(blockOref, { ...blockMeta, edit });
    }

    async performFileSave(contentToSave: string) {
        const filePath = await globalStore.get(this.statFilePath);
        if (filePath == null) {
            return;
        }
        try {
            await RpcApi.FileWriteCommand(TabRpcClient, {
                info: {
                    path: await this.formatRemoteUri(filePath, globalStore.get),
                },
                data64: stringToBase64(contentToSave),
            });
            const fileInfo = await globalStore.get(this.statFile);
            const saveTarget =
                fileInfo?.dir && fileInfo?.name
                    ? { dirPath: fileInfo.dir, fileName: fileInfo.name }
                    : this.splitPathParts(filePath);
            this.markSelfWrite(saveTarget.dirPath, saveTarget.fileName);
            globalStore.set(this.fileContent, contentToSave);
            if (globalStore.get(this.newFileContent) === contentToSave) {
                globalStore.set(this.newFileContent, null);
            }
            globalStore.set(this.errorMsgAtom, null);
            console.log("saved file", filePath);
        } catch (e) {
            const errorStatus: ErrorMsg = {
                status: "保存失败",
                text: `${e}`,
            };
            globalStore.set(this.errorMsgAtom, errorStatus);
        }
    }

    async handleFileSave(contentOverride?: string) {
        const contentToSave = contentOverride ?? globalStore.get(this.newFileContent);
        if (contentToSave == null) {
            console.log("not saving file, newFileContent is null");
            return;
        }
        this.queuedSaveContent = contentToSave;
        if (this.saveLoopPromise != null) {
            return this.saveLoopPromise;
        }
        this.saveLoopPromise = (async () => {
            while (this.queuedSaveContent != null) {
                const nextContent = this.queuedSaveContent;
                this.queuedSaveContent = null;
                await this.performFileSave(nextContent);
            }
        })().finally(() => {
            this.saveLoopPromise = null;
        });
        return this.saveLoopPromise;
    }

    async handleFileRevert() {
        const fileContent = await globalStore.get(this.fileContent);
        this.monacoRef.current?.setValue(fileContent);
        globalStore.set(this.newFileContent, null);
    }

    async refreshFileContent() {
        if (this.fileRefreshPromise != null) {
            return this.fileRefreshPromise;
        }
        this.fileRefreshPromise = (async () => {
            const fileName = globalStore.get(this.metaFilePath);
            if (fileName == null) {
                return;
            }
            if (globalStore.get(this.newFileContent) != null) {
                return;
            }

            // Keep the currently rendered text in place while the fresh contents
            // are loading so the block does not suspend and flash "加载中...".
            const currentContent = await globalStore.get(this.fileContent);
            if (currentContent != null) {
                globalStore.set(this.fileContentSaved, currentContent);
            }

            const file = await RpcApi.FileReadCommand(TabRpcClient, {
                info: {
                    path: await this.formatRemoteUri(fileName, globalStore.get),
                },
            });
            const latestContent = base64ToString(file?.data64) ?? "";
            if (latestContent !== currentContent) {
                globalStore.set(this.fileContentSaved, latestContent);
            }
            globalStore.set(this.errorMsgAtom, null);
        })().catch((e) => {
            const errorStatus: ErrorMsg = {
                status: "文件读取失败",
                text: `${e}`,
            };
            globalStore.set(this.errorMsgAtom, errorStatus);
        }).finally(() => {
            this.fileRefreshPromise = null;
        });
        return this.fileRefreshPromise;
    }

    triggerRefresh() {
        const loadableSV = globalStore.get(this.loadableSpecializedView);
        if (loadableSV.state === "hasData") {
            const specializedView = loadableSV.data.specializedView;
            if (
                specializedView === "codeedit" ||
                specializedView === "csv" ||
                specializedView === "markdown" ||
                specializedView === "html"
            ) {
                fireAndForget(() => this.refreshFileContent());
                return;
            }
        }
        globalStore.set(this.fileContentSaved, null);
        globalStore.set(this.refreshVersion, (v) => v + 1);
    }

    async handleOpenFile(filePath: string) {
        const fileInfo = await globalStore.get(this.statFile);
        this.updateOpenFileModalAndError(false);
        if (fileInfo == null) {
            return true;
        }
        try {
            this.goHistory(filePath);
            refocusNode(this.blockId);
        } catch (e) {
            globalStore.set(this.openFileError, e.message);
            console.error("Error opening file", filePath, e);
        }
    }

    isSpecializedView(sv: string): boolean {
        const loadableSV = globalStore.get(this.loadableSpecializedView);
        return loadableSV.state == "hasData" && loadableSV.data.specializedView == sv;
    }

    getSettingsMenuItems(): ContextMenuItem[] {
        const defaultFontSize = globalStore.get(getSettingsKeyAtom("editor:fontsize")) ?? 12;
        const blockData = globalStore.get(this.blockAtom);
        const overrideFontSize = blockData?.meta?.["editor:fontsize"];
        const menuItems: ContextMenuItem[] = [];
        const loadableSV = globalStore.get(this.loadableSpecializedView);
        if (loadableSV.state !== "hasData") {
            return menuItems;
        }
        const specializedView = loadableSV.data.specializedView;
        const mimeTypeLoadable = globalStore.get(this.fileMimeTypeLoadable);
        const mimeType = mimeTypeLoadable.state === "hasData" ? mimeTypeLoadable.data : null;
        const isMarkdownFile = specializedView === "codeedit" && isMarkdownLike(mimeType);

        if (specializedView === "directory" || specializedView === "streaming") {
            return menuItems;
        }

        if (specializedView === "codeedit") {
            const fontSizeSubMenu: ContextMenuItem[] = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(
                (fontSize: number) => {
                    return {
                        label: fontSize.toString() + "px",
                        type: "checkbox",
                        checked: overrideFontSize == fontSize,
                        click: () => {
                            RpcApi.SetMetaCommand(TabRpcClient, {
                                oref: WOS.makeORef("block", this.blockId),
                                meta: { "editor:fontsize": fontSize },
                            });
                        },
                    };
                }
            );
            fontSizeSubMenu.unshift({
                label: "默认（" + defaultFontSize + "px）",
                type: "checkbox",
                checked: overrideFontSize == null,
                click: () => {
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", this.blockId),
                        meta: { "editor:fontsize": null },
                    });
                },
            });
            menuItems.push({
                label: "编辑器字体大小",
                submenu: fontSizeSubMenu,
            });
        }
        const wordWrapAtom = getOverrideConfigAtom(this.blockId, "editor:wordwrap");
        const wordWrap = globalStore.get(wordWrapAtom) ?? true;
        if (isEditablePreviewView(specializedView)) {
            if (globalStore.get(this.newFileContent) != null) {
                menuItems.push({ type: "separator" });
                menuItems.push({
                    label: "还原文件",
                    click: () => fireAndForget(this.handleFileRevert.bind(this)),
                });
            }
            menuItems.push({ type: "separator" });
            menuItems.push({
                label: "自动换行",
                type: "checkbox",
                checked: wordWrap,
                click: () =>
                    fireAndForget(async () => {
                        const blockOref = WOS.makeORef("block", this.blockId);
                        await services.ObjectService.UpdateObjectMeta(blockOref, {
                            "editor:wordwrap": !wordWrap,
                        });
                    }),
            });
        }
        return menuItems;
    }

    giveFocus(): boolean {
        if (globalStore.get(this.pathEditMode)) {
            this.pathInputRef.current?.focus();
            return true;
        }
        const openModalOpen = globalStore.get(this.openFileModal);
        if (openModalOpen) {
            this.openFileModalGiveFocusRef.current?.();
            return true;
        }
        if (this.monacoRef.current) {
            this.monacoRef.current.focus();
            return true;
        }
        return false;
    }

    keyDownHandler(e: WaveKeyboardEvent): boolean {
        if (checkKeyPressed(e, "Cmd:l")) {
            this.beginPathEdit();
            return true;
        }
        if (checkKeyPressed(e, "Cmd:ArrowLeft")) {
            fireAndForget(this.goHistoryBack.bind(this));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:ArrowRight")) {
            fireAndForget(this.goHistoryForward.bind(this));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:ArrowUp")) {
            // handle up directory
            fireAndForget(() => this.goParentDirectory({}));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:o")) {
            this.toggleOpenFileModal();
            return true;
        }
        const canPreview = globalStore.get(this.canPreview);
        if (canPreview) {
            if (checkKeyPressed(e, "Cmd:e")) {
                const editMode = globalStore.get(this.editMode);
                fireAndForget(() => this.setEditMode(!editMode));
                return true;
            }
        }
        if (this.directoryKeyDownHandler) {
            const handled = this.directoryKeyDownHandler(e);
            if (handled) {
                return true;
            }
        }
        if (this.codeEditKeyDownHandler) {
            const handled = this.codeEditKeyDownHandler(e);
            if (handled) {
                return true;
            }
        }
        return false;
    }

    async formatRemoteUri(path: string, get: Getter): Promise<string> {
        return formatRemoteUri(path, await get(this.connection));
    }
}
