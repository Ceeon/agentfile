// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import {
    atoms,
    createBlockAtRightmost,
    getApi,
    globalStore,
} from "@/app/store/global";
import { ObjectService } from "@/app/store/services";
import { waveEventSubscribe } from "@/app/store/wps";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    buildDirectoryBackgroundMenuEntries,
    buildDirectoryItemMenuEntries,
    resolveDirectoryContextSelection,
    type DirectoryContextMenuActionId,
    type DirectoryContextMenuEntry,
} from "@/util/directorycontextmenu";
import { extractAllClipboardData, MIME_TO_EXT } from "@/util/clipboardutil";
import { checkKeyPressed } from "@/util/keyutil";
import {
    isInternalDirectoryProbeName,
    normalizeDirectoryWatchPath,
    shouldIgnoreVolumesDirectoryWatchEvent,
    shouldSkipAutoDirectoryRead,
    shouldRefreshDirectoryForEvent,
} from "@/util/directorywatchutil";
import { getOpenMenuActionHandler, normalizeMenuSeparators, type OpenMenuActionId } from "@/util/previewutil";
import { fireAndForget, isLocalConnName, makeConnRoute } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import { offset, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import base64 from "base64-js";
import clsx from "clsx";
import { PrimitiveAtom, atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { OverlayScrollbarsComponent, OverlayScrollbarsComponentRef } from "overlayscrollbars-react";
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { NativeTypes } from "react-dnd-html5-backend";
import { quote as shellQuote } from "shell-quote";
import "./directorypreview.scss";
import { EntryManagerOverlay, EntryManagerOverlayProps } from "./entry-manager";
import {
    handleFileDelete,
    handleRename,
    isIconValid,
    mergeError,
    overwriteError,
} from "./preview-directory-utils";
import { type PreviewModel } from "./preview-model";

const PageJumpSize = 20;
const VirtualRowHeight = 24;
const AutoRefreshCoalesceMs = 250;
const DirectoryReconcileFallbackIntervalMs = 2000;

type SortMode = "name" | "type" | "size" | "modified";
type SortDirection = "asc" | "desc";

type PreviewPrefs = {
    sortMode?: SortMode;
    sortDir?: SortDirection;
    foldersFirst?: boolean;
    compactFolders?: boolean;
    fileNesting?: boolean;
    showIcons?: boolean;
};

const DefaultPreviewPrefs: Required<PreviewPrefs> = {
    sortMode: "name",
    sortDir: "asc",
    foldersFirst: true,
    compactFolders: false,
    fileNesting: false,
    showIcons: true,
};
const PreviewPrefsMetaKey = "preview:dirprefs";
const DirectoryTreeStateMetaKey = "preview:dirtreestate";

type DirectoryTreeState = {
    rootPath?: string;
    expandedPaths?: string[];
};

function normalizeStoredExpandedPaths(state: DirectoryTreeState | null | undefined, dirPath: string): Set<string> {
    if (!dirPath || state?.rootPath !== dirPath || !Array.isArray(state?.expandedPaths)) {
        return new Set();
    }
    const dirPrefix = dirPath === "/" ? "/" : `${dirPath}/`;
    const normalizedPaths = state.expandedPaths.filter(
        (path): path is string =>
            typeof path === "string" &&
            path.length > 0 &&
            path !== dirPath &&
            path.startsWith(dirPrefix) &&
            !shouldSkipAutoDirectoryRead(path, dirPath)
    );
    return new Set(normalizedPaths);
}

function stringSetsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const value of a) {
        if (!b.has(value)) {
            return false;
        }
    }
    return true;
}

// Internal clipboard for copy/cut operations
interface FileClipboard {
    paths: string[];
    names: string[];
    isDirs: boolean[];
    operation: "copy" | "cut";
}

const DirectoryMenuLocale = "zh-CN" as const;

function makeClipboardImageName(blob: Blob, index: number) {
    const ext = MIME_TO_EXT[blob.type] ?? "png";
    return `clipboard-image-${Date.now()}-${index + 1}.${ext}`;
}

function normalizeClipboardFsPath(srcPath: string) {
    if (!srcPath) {
        return srcPath;
    }
    const normalized = srcPath.replace(/\/+$/, "");
    return normalized.length > 0 ? normalized : "/";
}

function filterInternalProbeEntries(entries: FileInfo[]): FileInfo[] {
    return entries.filter((entry) => !isInternalDirectoryProbeName(entry.name));
}

function makeDirectoryEntriesSignature(entries: FileInfo[] | null | undefined): string {
    if (!entries || entries.length === 0) {
        return "";
    }
    return JSON.stringify(
        entries
            .map((entry) => ({
                path: entry.path ?? "",
                name: entry.name ?? "",
                isdir: !!entry.isdir,
                size: entry.size ?? null,
                modtime: entry.modtime ?? null,
                mimetype: entry.mimetype ?? "",
            }))
            .sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
    );
}

function buildContextMenuItems(
    entries: DirectoryContextMenuEntry[],
    getHandler: (id: DirectoryContextMenuActionId) => (() => void)
): ContextMenuItem[] {
    return entries.map((entry) => {
        if (entry.type === "separator") {
            return { type: "separator" };
        }
        return {
            label: entry.label,
            click: getHandler(entry.id),
        };
    });
}

// Inline edit input component - completely isolated from parent events
interface InlineEditInputProps {
    initialValue: string;
    isDir: boolean;
    onComplete: (newValue: string) => void;
    onCancel: () => void;
}

function InlineEditInput({ initialValue, isDir, onComplete, onCancel }: InlineEditInputProps) {
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.focus();
            // Select only filename, not extension (like VSCode)
            const lastDot = initialValue.lastIndexOf(".");
            if (!isDir && lastDot > 0) {
                inputRef.current.setSelectionRange(0, lastDot);
            } else {
                inputRef.current.select();
            }
        }
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // Stop ALL events from propagating
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();

        if (e.key === "Enter") {
            e.preventDefault();
            if (value.trim()) {
                onComplete(value.trim());
            } else {
                onCancel();
            }
        } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
        }
    };

    const handleBlur = () => {
        if (value.trim() && value !== initialValue) {
            onComplete(value.trim());
        } else {
            onCancel();
        }
    };

    // Stop all events from bubbling
    const stopAllEvents = (e: React.SyntheticEvent) => {
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
    };

    return (
        <input
            ref={inputRef}
            className="dir-tree-name-input"
            value={value}
            onChange={(e) => {
                stopAllEvents(e);
                setValue(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={stopAllEvents}
            onKeyPress={stopAllEvents}
            onBlur={handleBlur}
            onClick={stopAllEvents}
            onMouseDown={stopAllEvents}
            onMouseUp={stopAllEvents}
            onDragStart={(e) => e.preventDefault()}
            onInput={stopAllEvents}
            onFocus={stopAllEvents}
        />
    );
}

// Extended FileInfo with tree-specific properties
interface TreeFileInfo extends FileInfo {
    depth: number;
    children?: TreeFileInfo[];
    isExpanded?: boolean;
    isLoading?: boolean;
    isNestParent?: boolean;
    displayName?: string;
    blocksExpansion?: boolean;
}

interface DirectoryTreeProps {
    model: PreviewModel;
    data: FileInfo[];
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSelectedPath: (_: string) => void;
    entryManagerOverlayPropsAtom: PrimitiveAtom<EntryManagerOverlayProps>;
    onFileDrop: (draggedFile: DraggedFile, targetPath: string) => Promise<void>;
    prefs: Required<PreviewPrefs>;
    updatePrefs: (patch: Partial<PreviewPrefs>) => void;
    // Multi-select props
    selectedPaths: Set<string>;
    setSelectedPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
    lastClickedIndex: number | null;
    setLastClickedIndex: React.Dispatch<React.SetStateAction<number | null>>;
    // Clipboard props
    clipboard: FileClipboard | null;
    setClipboard: React.Dispatch<React.SetStateAction<FileClipboard | null>>;
    onPaste: (clipboard: FileClipboard, targetDir: string) => Promise<void>;
    onPasteFromClipboard: (targetDir: string, e?: ClipboardEvent) => Promise<boolean>;
    dirPath: string;
    // External file drop
    onExternalFileDrop: (files: File[], targetPath: string) => Promise<void>;
    // Inline new item creation from parent
    newItemRequest: { isDir: boolean; parentPath?: string } | null;
    onNewItemHandled: () => void;
    autoRefreshRequest: { id: number; dirs: string[] };
}

function DirectoryTree({
    model,
    data,
    focusIndex,
    setFocusIndex,
    setSelectedPath,
    entryManagerOverlayPropsAtom,
    onFileDrop,
    prefs,
    updatePrefs,
    selectedPaths,
    setSelectedPaths,
    lastClickedIndex,
    setLastClickedIndex,
    clipboard,
    setClipboard,
    onPaste,
    onPasteFromClipboard,
    dirPath,
    onExternalFileDrop,
    newItemRequest,
    onNewItemHandled,
    autoRefreshRequest,
}: DirectoryTreeProps) {
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const conn = useAtomValue(model.connection);
    const connection = useAtomValue(model.connectionImmediate);
    const blockData = useAtomValue(model.blockAtom);
    const storedTreeState = (blockData?.meta?.[DirectoryTreeStateMetaKey] ?? null) as DirectoryTreeState | null;
    const persistedExpandedPaths = useMemo(
        () => normalizeStoredExpandedPaths(storedTreeState, dirPath),
        [storedTreeState, dirPath]
    );
    const isBlockFocused = useAtomValue(model.nodeModel.isFocused);
    const homeDir = useMemo(() => getApi().getHomeDir(), []);
    const showHiddenFiles = useAtomValue(model.showHiddenFiles);
    const setShowHiddenFiles = useSetAtom(model.showHiddenFiles);
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const mimetypes = fullConfig?.mimetypes ?? {};
    const osRef = useRef<OverlayScrollbarsComponentRef>(null);
    const bodyRef = useRef<HTMLDivElement>(null);

    // Track expanded directories
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(persistedExpandedPaths));
    // Track inline editing state: { path: string, isNew: boolean, isDir: boolean }
    const [editingItem, setEditingItem] = useState<{ path: string; isNew: boolean; isDir: boolean } | null>(null);
    // Track loaded children for each directory
    const [childrenCache, setChildrenCache] = useState<Map<string, FileInfo[]>>(new Map());
    const childrenCacheRef = useRef(childrenCache);
    const expandedPathsRef = useRef(expandedPaths);
    const reconcileInFlightRef = useRef(false);
    // Track loading state
    const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
    // Search/filter state
    const [searchQuery, setSearchQuery] = useState("");
    const [searchMatchCase, setSearchMatchCase] = useState(false);
    const [searchUseRegex, setSearchUseRegex] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    // Inline new item creation
    const [pendingNewItem, setPendingNewItem] = useState<{ parentPath: string; isDir: boolean } | null>(null);
    // Virtualized list state
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    // Flag to distinguish intentional focus changes from data-driven adjustments
    const shouldScrollToFocusRef = useRef(false);
    // Wrapper: set focus AND scroll into view (for user-initiated actions)
    const focusAndScroll = useCallback((idx: number) => {
        shouldScrollToFocusRef.current = true;
        setFocusIndex(idx);
    }, [setFocusIndex]);

    const pendingSetupDone = useRef(false);

    useEffect(() => {
        setExpandedPaths((prev) => (stringSetsEqual(prev, persistedExpandedPaths) ? prev : new Set(persistedExpandedPaths)));
    }, [persistedExpandedPaths]);

    useEffect(() => {
        childrenCacheRef.current = childrenCache;
    }, [childrenCache]);

    useEffect(() => {
        expandedPathsRef.current = expandedPaths;
    }, [expandedPaths]);

    const expandedPathsJson = useMemo(() => JSON.stringify(Array.from(expandedPaths).sort()), [expandedPaths]);
    const persistedExpandedPathsJson = useMemo(
        () => JSON.stringify(Array.from(persistedExpandedPaths).sort()),
        [persistedExpandedPaths]
    );

    useEffect(() => {
        const blockId = blockData?.oid;
        if (!blockId || !dirPath) {
            return;
        }
        if (expandedPathsJson === persistedExpandedPathsJson) {
            return;
        }
        const timer = window.setTimeout(() => {
            fireAndForget(() =>
                ObjectService.UpdateObjectMeta(
                    WOS.makeORef("block", blockId),
                    {
                        [DirectoryTreeStateMetaKey]: {
                            rootPath: dirPath,
                            expandedPaths: Array.from(expandedPaths).sort(),
                        },
                    } as MetaType
                )
            );
        }, 150);
        return () => window.clearTimeout(timer);
    }, [blockData?.oid, dirPath, expandedPaths, expandedPathsJson, persistedExpandedPathsJson]);

    const closeSearch = useCallback(() => {
        setSearchQuery("");
        setSearchOpen(false);
    }, []);
    const openTerminalHere = useCallback(() => {
        if (!dirPath) {
            return;
        }
        getApi().openDirectoryTarget("terminal", dirPath, connection);
    }, [connection, dirPath]);

    useEffect(() => {
        if (!searchOpen) {
            return;
        }
        const timer = window.setTimeout(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [searchOpen]);

    const readDirectoryEntries = useCallback(
        async (dp: string): Promise<FileInfo[]> => {
            if (shouldSkipAutoDirectoryRead(dp, dirPath)) {
                return [];
            }
            const file = await RpcApi.FileReadCommand(
                TabRpcClient,
                {
                    info: {
                        path: await model.formatRemoteUri(dp, globalStore.get),
                    },
                },
                null
            );
            return filterInternalProbeEntries(file.entries ?? []);
        },
        [dirPath, model]
    );

    const refreshCachedDirectory = useCallback(
        async (dp: string) => {
            try {
                const entries = await readDirectoryEntries(dp);
                setChildrenCache((prev) => new Map(prev).set(dp, entries));
            } catch (e) {
                // Directory no longer exists - remove from cache and expanded state
                console.error("Failed to reload directory:", dp, e);
                setChildrenCache((prev) => {
                    const next = new Map(prev);
                    next.delete(dp);
                    return next;
                });
                setExpandedPaths((prev) => {
                    const next = new Set(prev);
                    next.delete(dp);
                    return next;
                });
            }
        },
        [readDirectoryEntries]
    );

    const reconcileCachedDirectory = useCallback(
        async (dp: string) => {
            try {
                const entries = await readDirectoryEntries(dp);
                const nextSignature = makeDirectoryEntriesSignature(entries);
                const prevSignature = makeDirectoryEntriesSignature(childrenCacheRef.current.get(dp));
                if (nextSignature === prevSignature) {
                    return;
                }
                setChildrenCache((prev) => {
                    const currentEntries = prev.get(dp);
                    if (makeDirectoryEntriesSignature(currentEntries) === nextSignature) {
                        return prev;
                    }
                    const next = new Map(prev);
                    next.set(dp, entries);
                    return next;
                });
            } catch (e) {
                console.error("Failed to reconcile directory:", dp, e);
                setChildrenCache((prev) => {
                    if (!prev.has(dp)) {
                        return prev;
                    }
                    const next = new Map(prev);
                    next.delete(dp);
                    return next;
                });
                setExpandedPaths((prev) => {
                    if (!prev.has(dp)) {
                        return prev;
                    }
                    const next = new Set(prev);
                    next.delete(dp);
                    return next;
                });
            }
        },
        [readDirectoryEntries]
    );

    // Manual refreshes still reload every expanded directory.
    const refreshVersion = useAtomValue(model.refreshVersion);
    useEffect(() => {
        if (expandedPaths.size === 0) {
            return;
        }
        fireAndForget(() => Promise.all(Array.from(expandedPaths).map((dp) => refreshCachedDirectory(dp))));
    }, [refreshVersion, expandedPaths, refreshCachedDirectory]);

    // Automatic dirwatch refreshes only reload the affected expanded subdirectories.
    useEffect(() => {
        if (autoRefreshRequest.id === 0 || autoRefreshRequest.dirs.length === 0) {
            return;
        }
        const normalizedRootDir = normalizeDirectoryWatchPath(dirPath, homeDir);
        const expandedPathMap = new Map<string, string>();
        for (const expandedPath of expandedPaths) {
            const normalizedPath = normalizeDirectoryWatchPath(expandedPath, homeDir);
            if (normalizedPath) {
                expandedPathMap.set(normalizedPath, expandedPath);
            }
        }
        const dirsToRefresh = Array.from(
            new Set(
                autoRefreshRequest.dirs
                    .filter((dp) => dp !== normalizedRootDir)
                    .map((dp) => expandedPathMap.get(dp))
                    .filter((dp): dp is string => dp != null && !shouldSkipAutoDirectoryRead(dp, dirPath))
            )
        );
        if (dirsToRefresh.length === 0) {
            return;
        }
        fireAndForget(() => Promise.all(dirsToRefresh.map((dp) => refreshCachedDirectory(dp))));
    }, [autoRefreshRequest, dirPath, expandedPaths, homeDir, refreshCachedDirectory]);

    useEffect(() => {
        if (!dirPath) {
            return;
        }
        const intervalId = window.setInterval(() => {
            if (reconcileInFlightRef.current) {
                return;
            }
            const expandedToCheck = Array.from(expandedPathsRef.current).filter(
                (dp) => dp !== dirPath && !shouldSkipAutoDirectoryRead(dp, dirPath)
            );
            if (expandedToCheck.length === 0) {
                return;
            }
            reconcileInFlightRef.current = true;
            fireAndForget(() =>
                Promise.all(expandedToCheck.map((dp) => reconcileCachedDirectory(dp))).finally(() => {
                    reconcileInFlightRef.current = false;
                })
            );
        }, DirectoryReconcileFallbackIntervalMs);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [dirPath, reconcileCachedDirectory]);

    // Subscribe to directory watch for expanded subdirectories
    const watchedExpandedRef = useRef<Set<string>>(new Set());
    const watchBlockIdRef = useRef<string | null>(null);
    const watchDirPathRef = useRef(dirPath);
    const watchConnRef = useRef(connection);
    useEffect(() => {
        watchBlockIdRef.current = blockData?.oid ?? null;
        watchDirPathRef.current = dirPath;
        watchConnRef.current = connection;
    }, [blockData?.oid, connection, dirPath]);
    useEffect(() => {
        const blockId = blockData?.oid;
        if (!blockId) return;
        const dirWatchRpcOpts = isLocalConnName(connection) ? undefined : { route: makeConnRoute(connection) };

        const currentExpanded = new Set(expandedPaths);
        const prevWatched = watchedExpandedRef.current;

        // Subscribe new paths
        for (const dp of currentExpanded) {
            if (dp !== dirPath && !prevWatched.has(dp) && !shouldSkipAutoDirectoryRead(dp, dirPath)) {
                fireAndForget(async () => {
                    try {
                        await RpcApi.DirWatchSubscribeCommand(
                            TabRpcClient,
                            { dirpath: dp, blockid: blockId },
                            dirWatchRpcOpts
                        );
                    } catch (e) { /* ignore */ }
                });
            }
        }
        // Unsubscribe removed paths
        for (const dp of prevWatched) {
            if (!currentExpanded.has(dp) || shouldSkipAutoDirectoryRead(dp, dirPath)) {
                fireAndForget(async () => {
                    try {
                        await RpcApi.DirWatchUnsubscribeCommand(
                            TabRpcClient,
                            { dirpath: dp, blockid: blockId },
                            dirWatchRpcOpts
                        );
                    } catch (e) { /* ignore */ }
                });
            }
        }
        watchedExpandedRef.current = currentExpanded;
    }, [expandedPaths, blockData?.oid, connection, dirPath]);

    // Cleanup all expanded watches on unmount only
    useEffect(() => {
        return () => {
            const blockId = watchBlockIdRef.current;
            const cleanupDirPath = watchDirPathRef.current;
            const cleanupConnection = watchConnRef.current;
            if (!blockId) return;
            const dirWatchRpcOpts = isLocalConnName(cleanupConnection)
                ? undefined
                : { route: makeConnRoute(cleanupConnection) };
            for (const dp of watchedExpandedRef.current) {
                if (dp !== cleanupDirPath) {
                    fireAndForget(async () => {
                        try {
                            await RpcApi.DirWatchUnsubscribeCommand(
                                TabRpcClient,
                                { dirpath: dp, blockid: blockId },
                                dirWatchRpcOpts
                            );
                        } catch (e) { /* ignore */ }
                    });
                }
            }
        };
    }, []);

    const setEntryManagerProps = useSetAtom(entryManagerOverlayPropsAtom);

    const getIconFromMimeType = useCallback(
        (mimeType: string): string => {
            while (mimeType.length > 0) {
                const icon = mimetypes[mimeType]?.icon ?? null;
                if (isIconValid(icon)) {
                    return `fa fa-solid fa-${icon} fa-fw`;
                }
                mimeType = mimeType.slice(0, -1);
            }
            return "fa fa-solid fa-file fa-fw";
        },
        [mimetypes]
    );

    const getIconColor = useCallback(
        (mimeType: string): string => mimetypes[mimeType]?.color ?? "inherit",
        [mimetypes]
    );

    const updateName = useCallback(
        (path: string, isDir: boolean) => {
            setEditingItem({ path, isNew: false, isDir });
        },
        []
    );

    // Load children for a directory
    const loadChildren = useCallback(
        async (dp: string): Promise<FileInfo[] | null> => {
            if (childrenCache.has(dp)) {
                return childrenCache.get(dp) ?? [];
            }
            if (loadingPaths.has(dp)) {
                return null;
            }

            setLoadingPaths((prev) => new Set(prev).add(dp));

            try {
                const entries = await readDirectoryEntries(dp);
                setChildrenCache((prev) => new Map(prev).set(dp, entries));
                return entries;
            } catch (e) {
                console.error("Failed to load directory:", e);
            } finally {
                setLoadingPaths((prev) => {
                    const next = new Set(prev);
                    next.delete(dp);
                    return next;
                });
            }
            return null;
        },
        [childrenCache, loadingPaths, readDirectoryEntries]
    );

    // Toggle directory expansion
    const toggleExpand = useCallback(
        (path: string, isDir: boolean, isNestParent: boolean) => {
            if (!isDir && !isNestParent) return;
            if (isDir && shouldSkipAutoDirectoryRead(path, dirPath)) return;

            setExpandedPaths((prev) => {
                const next = new Set(prev);
                if (next.has(path)) {
                    next.delete(path);
                } else {
                    next.add(path);
                    if (isDir) {
                        loadChildren(path);
                    }
                }
                return next;
            });
        },
        [dirPath, loadChildren]
    );

    const matchesSearch = useCallback(
        (name: string): boolean => {
            if (!searchQuery) return true;
            const target = searchMatchCase ? name : name.toLowerCase();
            if (searchUseRegex) {
                try {
                    const regex = new RegExp(searchQuery, searchMatchCase ? "" : "i");
                    return regex.test(name);
                } catch {
                    return true;
                }
            }
            const query = searchMatchCase ? searchQuery : searchQuery.toLowerCase();
            return target.includes(query);
        },
        [searchQuery, searchMatchCase, searchUseRegex]
    );

    const sortFiles = useCallback(
        (files: FileInfo[]): FileInfo[] => {
            const direction = prefs.sortDir === "desc" ? -1 : 1;
            return [...files].sort((a, b) => {
                // Optional folders first
                if (prefs.foldersFirst) {
                    if (a.isdir && !b.isdir) return -1;
                    if (!a.isdir && b.isdir) return 1;
                }

                const getTypeKey = (item: FileInfo) => {
                    if (item.isdir) return "";
                    const name = item.name ?? "";
                    const lastDot = name.lastIndexOf(".");
                    return lastDot >= 0 ? name.slice(lastDot + 1).toLowerCase() : "";
                };

                let cmp = 0;
                switch (prefs.sortMode) {
                    case "type":
                        cmp = getTypeKey(a).localeCompare(getTypeKey(b));
                        break;
                    case "size":
                        cmp = (a.size ?? 0) - (b.size ?? 0);
                        break;
                    case "modified":
                        cmp = (a.modtime ?? 0) - (b.modtime ?? 0);
                        break;
                    case "name":
                    default:
                        cmp = (a.name ?? "").localeCompare(b.name ?? "");
                        break;
                }
                if (cmp === 0) {
                    cmp = (a.name ?? "").localeCompare(b.name ?? "");
                }
                return cmp * direction;
            });
        },
        [prefs]
    );

    const prepareEntries = useCallback(
        (entries: FileInfo[]): { entries: FileInfo[]; nestedMap: Map<string, FileInfo[]> } => {
            const filtered = entries.filter((fileInfo) => {
                if (!fileInfo?.name) return false;
                if (!showHiddenFiles && fileInfo.name.startsWith(".")) return false;
                return true;
            });

            const sorted = sortFiles(filtered);
            if (!prefs.fileNesting) {
                return { entries: sorted, nestedMap: new Map() };
            }

            const groups = new Map<string, FileInfo[]>();
            const isNestable = (item: FileInfo) => !item.isdir && item.name;
            for (const item of sorted) {
                if (!isNestable(item)) continue;
                const name = item.name ?? "";
                const stem = name.split(".")[0];
                if (!stem) continue;
                const group = groups.get(stem) ?? [];
                group.push(item);
                groups.set(stem, group);
            }

            const nestedMap = new Map<string, FileInfo[]>();
            const nestedChildPaths = new Set<string>();
            const extPriority = ["ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "cpp", "c", "json", "yaml", "yml", "toml", "md"];
            const pickParent = (items: FileInfo[]) => {
                return [...items].sort((a, b) => {
                    const nameA = a.name ?? "";
                    const nameB = b.name ?? "";
                    const dotsA = (nameA.match(/\./g) ?? []).length;
                    const dotsB = (nameB.match(/\./g) ?? []).length;
                    if (dotsA !== dotsB) return dotsA - dotsB;
                    const extA = nameA.split(".").pop() ?? "";
                    const extB = nameB.split(".").pop() ?? "";
                    const prioA = extPriority.indexOf(extA);
                    const prioB = extPriority.indexOf(extB);
                    if (prioA !== prioB) {
                        if (prioA === -1) return 1;
                        if (prioB === -1) return -1;
                        return prioA - prioB;
                    }
                    return nameA.localeCompare(nameB);
                })[0];
            };

            for (const [, items] of groups) {
                if (items.length < 2) continue;
                const parent = pickParent(items);
                if (!parent) continue;
                const children = items.filter((item) => item.path !== parent.path);
                if (children.length === 0) continue;
                children.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
                nestedMap.set(parent.path, children);
                for (const child of children) nestedChildPaths.add(child.path);
            }

            const baseEntries = sorted.filter((item) => !nestedChildPaths.has(item.path));
            return { entries: baseEntries, nestedMap };
        },
        [prefs.fileNesting, showHiddenFiles, sortFiles]
    );

    // Build flat list of visible items for rendering
    const flattenTree = useCallback(
        (items: FileInfo[], depth: number, parentPath: string | null, parentMap: Map<string, string | null>): TreeFileInfo[] => {
            const result: TreeFileInfo[] = [];
            const { entries, nestedMap } = prepareEntries(items);
            const searchActive = searchQuery.length > 0;

            for (const item of entries) {
                if (!item?.name) continue;
                let displayName = item.name ?? "";
                let effectivePath = item.path;
                let effectiveChildren = item.isdir ? childrenCache.get(item.path) : undefined;
                let isCompact = false;
                const blocksExpansion = item.isdir && shouldSkipAutoDirectoryRead(item.path, dirPath);

                if (prefs.compactFolders && item.isdir && !blocksExpansion) {
                    let curPath = item.path;
                    let curName = item.name ?? "";
                    let curChildren = effectiveChildren;
                    while (curChildren && curChildren.length > 0) {
                        const prepared = prepareEntries(curChildren).entries;
                        const dirChildren = prepared.filter((child) => child.isdir);
                        const fileChildren = prepared.filter((child) => !child.isdir);
                        if (fileChildren.length > 0 || dirChildren.length !== 1) {
                            break;
                        }
                        const nextDir = dirChildren[0];
                        curName = `${curName}/${nextDir.name ?? ""}`;
                        curPath = nextDir.path;
                        curChildren = childrenCache.get(curPath);
                        effectiveChildren = curChildren;
                        isCompact = true;
                        if (!curChildren) {
                            break;
                        }
                    }
                    displayName = curName;
                    effectivePath = curPath;
                }

                const isNestParent = !item.isdir && nestedMap.has(item.path);
                const isExpanded = expandedPaths.has(effectivePath) || searchActive;
                const hasExpandableChildren =
                    (item.isdir && effectiveChildren && effectiveChildren.length > 0) ||
                    (isNestParent && (nestedMap.get(item.path)?.length ?? 0) > 0);

                const effectiveName = effectivePath.split("/").pop() ?? item.name;
                const treeItem: TreeFileInfo = {
                    ...item,
                    name: effectiveName,
                    path: effectivePath,
                    depth,
                    displayName: isCompact ? displayName : undefined,
                    isExpanded: isExpanded && hasExpandableChildren,
                    isLoading: loadingPaths.has(effectivePath),
                    isNestParent,
                    blocksExpansion,
                };
                parentMap.set(effectivePath, parentPath);
                result.push(treeItem);

                if (item.isdir && isExpanded && effectiveChildren && effectiveChildren.length > 0) {
                    result.push(...flattenTree(effectiveChildren, depth + 1, effectivePath, parentMap));
                } else if (isNestParent && isExpanded) {
                    const nestedChildren = nestedMap.get(item.path) ?? [];
                    for (const child of nestedChildren) {
                        if (!child?.name) continue;
                        parentMap.set(child.path, effectivePath);
                        result.push({
                            ...child,
                            depth: depth + 1,
                            isExpanded: false,
                            isLoading: false,
                        });
                    }
                }
            }

            return result;
        },
        [prepareEntries, childrenCache, expandedPaths, loadingPaths, prefs.compactFolders, searchQuery]
    );

    const { rawFlatData, parentByPath } = useMemo(() => {
        const parentMap = new Map<string, string | null>();
        const flat = flattenTree(data, 0, null, parentMap);
        return { rawFlatData: flat, parentByPath: parentMap };
    }, [data, flattenTree]);

    const filteredFlatData = useMemo(() => {
        if (!searchQuery) return rawFlatData;
        const include = new Set<string>();
        for (const item of rawFlatData) {
            const name = item.displayName ?? item.name ?? "";
            if (!matchesSearch(name)) continue;
            let cur: string | null | undefined = item.path;
            while (cur != null) {
                include.add(cur);
                cur = parentByPath.get(cur);
            }
        }
        return rawFlatData.filter((item) => include.has(item.path));
    }, [rawFlatData, searchQuery, matchesSearch, parentByPath]);

    // Inject phantom entry for inline new item creation
    const flatData = useMemo(() => {
        if (!pendingNewItem) return filteredFlatData;

        const result = [...filteredFlatData];
        const phantomPath = pendingNewItem.parentPath + "/__new__";
        const isRoot = pendingNewItem.parentPath === dirPath;

        let insertIdx: number;
        let depth: number;

        if (isRoot) {
            insertIdx = 0;
            depth = 0;
        } else {
            const parentIdx = result.findIndex((item) => item.path === pendingNewItem.parentPath);
            if (parentIdx >= 0) {
                insertIdx = parentIdx + 1;
                depth = result[parentIdx].depth + 1;
            } else {
                insertIdx = result.length;
                depth = 0;
            }
        }

        const phantom: TreeFileInfo = {
            name: "",
            path: phantomPath,
            isdir: pendingNewItem.isDir,
            depth,
            modtime: 0,
            mimetype: pendingNewItem.isDir ? "directory" : "",
        };

        result.splice(insertIdx, 0, phantom);
        return result;
    }, [filteredFlatData, pendingNewItem, dirPath]);

    // Start inline creation of a new file/folder
    const startNewItem = useCallback(
        (isDir: boolean) => {
            setPendingNewItem(null);
            setEditingItem(null);
            setSearchQuery("");
            pendingSetupDone.current = false;

            const focusedItem = flatData[focusIndex];
            let parentPath: string;

            if (!focusedItem || focusedItem.name === "..") {
                parentPath = dirPath;
            } else if (focusedItem.isdir) {
                parentPath = focusedItem.path;
            } else {
                const parent = focusedItem.path.replace(/\/[^/]+$/, "");
                parentPath = parent || dirPath;
            }

            if (parentPath !== dirPath && !expandedPaths.has(parentPath)) {
                setExpandedPaths((prev) => new Set(prev).add(parentPath));
                loadChildren(parentPath);
            }

            setPendingNewItem({ parentPath, isDir });
        },
        [flatData, focusIndex, dirPath, expandedPaths, loadChildren]
    );

    // Handle newItemRequest from parent (DirectoryPreview background context menu)
    useEffect(() => {
        if (!newItemRequest) return;

        const parentPath = newItemRequest.parentPath ?? dirPath;
        setPendingNewItem(null);
        setEditingItem(null);
        pendingSetupDone.current = false;

        if (parentPath !== dirPath && !expandedPaths.has(parentPath)) {
            setExpandedPaths((prev) => new Set(prev).add(parentPath));
            loadChildren(parentPath);
        }

        setPendingNewItem({ parentPath, isDir: newItemRequest.isDir });
        onNewItemHandled();
    }, [newItemRequest]);

    // Set up inline editing once phantom entry is ready
    useEffect(() => {
        if (!pendingNewItem) {
            pendingSetupDone.current = false;
            return;
        }
        if (pendingSetupDone.current) return;

        const { parentPath, isDir } = pendingNewItem;
        if (parentPath !== dirPath && loadingPaths.has(parentPath)) return;

        pendingSetupDone.current = true;

        const phantomPath = parentPath + "/__new__";
        setEditingItem({ path: phantomPath, isNew: true, isDir });

        const phantomIdx = flatData.findIndex((item) => item.path === phantomPath);
        if (phantomIdx >= 0) {
            focusAndScroll(phantomIdx);
        }
    }, [pendingNewItem, loadingPaths, flatData, dirPath]);

    // Focus preservation: track focused path by ref so it survives data changes
    const focusedPathRef = useRef<string | null>(null);
    const pendingFocusPathRef = useRef<string | null>(null);

    // Track the currently focused path (only updates when focusIndex changes from user action)
    useEffect(() => {
        const path = flatData[focusIndex]?.path ?? null;
        if (path && !path.includes("/__new__")) {
            focusedPathRef.current = path;
        }
    }, [focusIndex]);

    // When flatData changes, restore focus by path instead of keeping stale numeric index
    useEffect(() => {
        // First: check if we should focus a newly created item
        if (pendingFocusPathRef.current) {
            const idx = flatData.findIndex((item) => item.path === pendingFocusPathRef.current);
            if (idx >= 0) {
                shouldScrollToFocusRef.current = true;
                setFocusIndex(idx);
                pendingFocusPathRef.current = null;
                return;
            }
        }

        // Second: try to keep focus on the same item by path (no scroll — just index adjustment)
        if (focusedPathRef.current) {
            const idx = flatData.findIndex((item) => item.path === focusedPathRef.current);
            if (idx >= 0 && idx !== focusIndex) {
                setFocusIndex(idx);
                return;
            }
        }

        // Fallback: clamp focusIndex to valid range
        if (flatData.length !== 0 && focusIndex > flatData.length - 1) {
            setFocusIndex(flatData.length - 1);
        }
    }, [flatData]);

    // Update selected path when focus changes
    useEffect(() => {
        setSelectedPath(flatData[focusIndex]?.path ?? null);
    }, [focusIndex, flatData, setSelectedPath]);

    // Register directoryKeyDownHandler inside DirectoryTree (has access to flatData, expandedPaths, etc.)
    useEffect(() => {
        model.directoryKeyDownHandler = (waveEvent: WaveKeyboardEvent): boolean => {
            // Don't handle keys when editing
            if (editingItem != null) return false;
            const activeEl = document.activeElement as HTMLElement | null;
            if (activeEl === searchInputRef.current) {
                return false;
            }

            // Cmd/Ctrl+F - focus search
            if (checkKeyPressed(waveEvent, "Cmd:f") || checkKeyPressed(waveEvent, "Ctrl:f")) {
                setSearchOpen(true);
                return true;
            }

            // F2 - Rename
            if (checkKeyPressed(waveEvent, "F2")) {
                const item = flatData[focusIndex];
                if (item && item.name !== "..") {
                    updateName(item.path, item.isdir);
                }
                return true;
            }

            // Delete / Cmd+Backspace - Delete
            if (checkKeyPressed(waveEvent, "Delete") || checkKeyPressed(waveEvent, "Cmd:Backspace")) {
                if (selectedPaths.size > 0) {
                    for (const p of selectedPaths) {
                        handleFileDelete(model, p, false, setErrorMsg);
                    }
                    setSelectedPaths(new Set());
                } else {
                    const item = flatData[focusIndex];
                    if (item && item.name !== "..") {
                        handleFileDelete(model, item.path, false, setErrorMsg);
                    }
                }
                return true;
            }

            // Cmd/Ctrl+C - Copy
            if (checkKeyPressed(waveEvent, "Cmd:c") || checkKeyPressed(waveEvent, "Ctrl:c")) {
                const items = getSelectedItems();
                if (items.length > 0) {
                    setClipboard({
                        paths: items.map((i) => i.path),
                        names: items.map((i) => i.name),
                        isDirs: items.map((i) => i.isdir),
                        operation: "copy",
                    });
                }
                return true;
            }

            // Cmd/Ctrl+X - Cut
            if (checkKeyPressed(waveEvent, "Cmd:x") || checkKeyPressed(waveEvent, "Ctrl:x")) {
                const items = getSelectedItems();
                if (items.length > 0) {
                    setClipboard({
                        paths: items.map((i) => i.path),
                        names: items.map((i) => i.name),
                        isDirs: items.map((i) => i.isdir),
                        operation: "cut",
                    });
                }
                return true;
            }

            // Cmd/Ctrl+V - Paste
            if (checkKeyPressed(waveEvent, "Cmd:v") || checkKeyPressed(waveEvent, "Ctrl:v")) {
                getApi().nativePaste();
                return true;
            }

            // Cmd/Ctrl+A - Select All
            if (checkKeyPressed(waveEvent, "Cmd:a") || checkKeyPressed(waveEvent, "Ctrl:a")) {
                const allPaths = new Set<string>();
                for (const item of flatData) {
                    if (item.name !== "..") {
                        allPaths.add(item.path);
                    }
                }
                setSelectedPaths(allPaths);
                return true;
            }

            // Cmd/Ctrl+N - New File
            if (checkKeyPressed(waveEvent, "Cmd:n") || checkKeyPressed(waveEvent, "Ctrl:n")) {
                startNewItem(false);
                return true;
            }

            // Cmd/Ctrl+Shift+N - New Folder
            if (checkKeyPressed(waveEvent, "Cmd:Shift:n") || checkKeyPressed(waveEvent, "Ctrl:Shift:n")) {
                startNewItem(true);
                return true;
            }

            // Cmd/Ctrl+Shift+. - Toggle hidden files
            if (
                checkKeyPressed(waveEvent, "Cmd:Shift:.") ||
                checkKeyPressed(waveEvent, "Cmd:Shift:>") ||
                checkKeyPressed(waveEvent, "Ctrl:Shift:.") ||
                checkKeyPressed(waveEvent, "Ctrl:Shift:>")
            ) {
                setShowHiddenFiles(!showHiddenFiles);
                return true;
            }

            // F5 - Refresh
            if (checkKeyPressed(waveEvent, "F5")) {
                model.refreshCallback?.();
                return true;
            }

            // ArrowUp
            if (checkKeyPressed(waveEvent, "ArrowUp")) {
                focusAndScroll(Math.max(focusIndex - 1, 0));
                setSelectedPaths(new Set());
                return true;
            }

            // Shift+ArrowUp - extend selection upward
            if (checkKeyPressed(waveEvent, "Shift:ArrowUp")) {
                const newIdx = Math.max(focusIndex - 1, 0);
                const item = flatData[newIdx];
                if (item && item.name !== "..") {
                    setSelectedPaths((prev) => {
                        const next = new Set(prev);
                        next.add(item.path);
                        const curItem = flatData[focusIndex];
                        if (curItem && curItem.name !== "..") next.add(curItem.path);
                        return next;
                    });
                }
                focusAndScroll(newIdx);
                return true;
            }

            // ArrowDown
            if (checkKeyPressed(waveEvent, "ArrowDown")) {
                focusAndScroll(Math.min(focusIndex + 1, flatData.length - 1));
                setSelectedPaths(new Set());
                return true;
            }

            // Shift+ArrowDown - extend selection downward
            if (checkKeyPressed(waveEvent, "Shift:ArrowDown")) {
                const newIdx = Math.min(focusIndex + 1, flatData.length - 1);
                const item = flatData[newIdx];
                if (item && item.name !== "..") {
                    setSelectedPaths((prev) => {
                        const next = new Set(prev);
                        next.add(item.path);
                        const curItem = flatData[focusIndex];
                        if (curItem && curItem.name !== "..") next.add(curItem.path);
                        return next;
                    });
                }
                focusAndScroll(newIdx);
                return true;
            }

            // ArrowLeft - collapse or go to parent
            if (checkKeyPressed(waveEvent, "ArrowLeft")) {
                const item = flatData[focusIndex];
                if (item) {
                    if ((item.isdir || item.isNestParent) && !item.blocksExpansion && expandedPaths.has(item.path)) {
                        // Collapse the directory
                        toggleExpand(item.path, item.isdir, item.isNestParent ?? false);
                    } else if (item.depth > 0) {
                        // Jump to parent node
                        for (let i = focusIndex - 1; i >= 0; i--) {
                            if (flatData[i].depth < item.depth) {
                                focusAndScroll(i);
                                break;
                            }
                        }
                    }
                }
                return true;
            }

            // ArrowRight - expand or go to first child
            if (checkKeyPressed(waveEvent, "ArrowRight")) {
                const item = flatData[focusIndex];
                const isExpandable = item && !item.blocksExpansion && ((item.isdir && item.name !== "..") || item.isNestParent);
                if (isExpandable && item) {
                    if (!expandedPaths.has(item.path)) {
                        toggleExpand(item.path, item.isdir, item.isNestParent ?? false);
                    } else if (focusIndex + 1 < flatData.length && flatData[focusIndex + 1].depth > item.depth) {
                        focusAndScroll(focusIndex + 1);
                    }
                }
                return true;
            }

            // Home - go to first item
            if (checkKeyPressed(waveEvent, "Home")) {
                focusAndScroll(0);
                setSelectedPaths(new Set());
                return true;
            }

            // End - go to last item
            if (checkKeyPressed(waveEvent, "End")) {
                focusAndScroll(flatData.length - 1);
                setSelectedPaths(new Set());
                return true;
            }

            // PageUp/PageDown
            if (checkKeyPressed(waveEvent, "PageUp")) {
                focusAndScroll(Math.max(focusIndex - PageJumpSize, 0));
                setSelectedPaths(new Set());
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageDown")) {
                focusAndScroll(Math.min(focusIndex + PageJumpSize, flatData.length - 1));
                setSelectedPaths(new Set());
                return true;
            }

            // Enter - open file/directory
            if (checkKeyPressed(waveEvent, "Enter")) {
                if (flatData.length === 0) {
                    return false;
                }
                const item = flatData[focusIndex];
                if (item) {
                    if (item.isdir) {
                        model.goHistory(item.path);
                    } else {
                        fireAndForget(async () => {
                            await createBlockAtRightmost(
                                {
                                    meta: {
                                        view: "preview",
                                        file: item.path,
                                        connection: conn,
                                    },
                                }
                            );
                        });
                    }
                }
                return true;
            }

            // Escape - clear filter
            if (checkKeyPressed(waveEvent, "Escape")) {
                if (searchQuery) {
                    closeSearch();
                    return true;
                }
                if (searchOpen) {
                    setSearchOpen(false);
                    return true;
                }
                if (selectedPaths.size > 0) {
                    setSelectedPaths(new Set());
                    return true;
                }
                return false;
            }

            return false;
        };
        return () => {
            model.directoryKeyDownHandler = null;
        };
    }, [
        flatData, focusIndex, selectedPaths, clipboard, editingItem, expandedPaths,
        dirPath, conn, searchOpen, searchQuery, model, setFocusIndex, focusAndScroll,
        setSelectedPaths, setClipboard, startNewItem, updateName, setErrorMsg, toggleExpand,
        showHiddenFiles, setShowHiddenFiles, closeSearch,
    ]);

    // Helper: get selected items (or focused item if no selection)
    const getSelectedItems = useCallback((): TreeFileInfo[] => {
        if (selectedPaths.size > 0) {
            return flatData.filter((item) => selectedPaths.has(item.path) && item.name !== "..");
        }
        const item = flatData[focusIndex];
        if (item && item.name !== "..") {
            return [item];
        }
        return [];
    }, [flatData, focusIndex, selectedPaths]);

    const getPasteTargetDir = useCallback(() => {
        const focusedItem = flatData[focusIndex];
        return focusedItem?.isdir && focusedItem.name !== ".." ? focusedItem.path : dirPath;
    }, [dirPath, flatData, focusIndex]);

    const writeClipboardText = useCallback(async (text: string) => {
        await getApi().writeClipboardText(text);
    }, []);

    useEffect(() => {
        const handleWindowPaste = (e: ClipboardEvent) => {
            if (!isBlockFocused || !document.hasFocus() || editingItem != null) {
                return;
            }
            const activeEl = document.activeElement as HTMLElement | null;
            if (
                activeEl === searchInputRef.current ||
                activeEl?.tagName === "INPUT" ||
                activeEl?.tagName === "TEXTAREA" ||
                activeEl?.isContentEditable
            ) {
                return;
            }
            const targetDir = getPasteTargetDir();
            e.preventDefault();
            e.stopPropagation();
            fireAndForget(async () => {
                await onPasteFromClipboard(targetDir, e);
            });
        };

        window.addEventListener("paste", handleWindowPaste, true);
        return () => {
            window.removeEventListener("paste", handleWindowPaste, true);
        };
    }, [editingItem, getPasteTargetDir, isBlockFocused, onPasteFromClipboard]);

    const collapseAll = useCallback(() => {
        setExpandedPaths(new Set());
    }, []);

    const handleViewOptionsMenu = useCallback(
        (e: React.MouseEvent) => {
            const menu: ContextMenuItem[] = [
                {
                    label: "排序方式",
                    submenu: [
                        {
                            label: "名称",
                            type: "radio",
                            checked: prefs.sortMode === "name",
                            click: () => updatePrefs({ sortMode: "name" }),
                        },
                        {
                            label: "类型",
                            type: "radio",
                            checked: prefs.sortMode === "type",
                            click: () => updatePrefs({ sortMode: "type" }),
                        },
                        {
                            label: "大小",
                            type: "radio",
                            checked: prefs.sortMode === "size",
                            click: () => updatePrefs({ sortMode: "size" }),
                        },
                        {
                            label: "修改时间",
                            type: "radio",
                            checked: prefs.sortMode === "modified",
                            click: () => updatePrefs({ sortMode: "modified" }),
                        },
                    ],
                },
                {
                    label: "排序顺序",
                    submenu: [
                        {
                            label: "升序",
                            type: "radio",
                            checked: prefs.sortDir === "asc",
                            click: () => updatePrefs({ sortDir: "asc" }),
                        },
                        {
                            label: "降序",
                            type: "radio",
                            checked: prefs.sortDir === "desc",
                            click: () => updatePrefs({ sortDir: "desc" }),
                        },
                    ],
                },
                { type: "separator" },
                {
                    label: "文件夹优先",
                    type: "checkbox",
                    checked: prefs.foldersFirst,
                    click: () => updatePrefs({ foldersFirst: !prefs.foldersFirst }),
                },
                {
                    label: "压缩文件夹显示",
                    type: "checkbox",
                    checked: prefs.compactFolders,
                    click: () => updatePrefs({ compactFolders: !prefs.compactFolders }),
                },
                {
                    label: "文件嵌套",
                    type: "checkbox",
                    checked: prefs.fileNesting,
                    click: () => updatePrefs({ fileNesting: !prefs.fileNesting }),
                },
                {
                    label: "显示图标",
                    type: "checkbox",
                    checked: prefs.showIcons,
                    click: () => updatePrefs({ showIcons: !prefs.showIcons }),
                },
                {
                    label: "显示隐藏文件",
                    type: "checkbox",
                    checked: showHiddenFiles,
                    click: () => setShowHiddenFiles(!showHiddenFiles),
                },
            ];
            ContextMenuModel.showContextMenu(menu, e);
        },
        [prefs, showHiddenFiles, updatePrefs, setShowHiddenFiles]
    );

    // Track scroll position for virtualization
    useEffect(() => {
        if (!osRef.current) return;
        const viewport = osRef.current.osInstance().elements().viewport;
        const handleScroll = () => setScrollTop(viewport.scrollTop);
        const ro = new ResizeObserver(() => setViewportHeight(viewport.offsetHeight));
        ro.observe(viewport);
        setScrollTop(viewport.scrollTop);
        setViewportHeight(viewport.offsetHeight);
        viewport.addEventListener("scroll", handleScroll);
        return () => {
            viewport.removeEventListener("scroll", handleScroll);
            ro.disconnect();
        };
    }, [osRef]);

    // Scroll focused item into view (only on intentional focus changes)
    useEffect(() => {
        if (!shouldScrollToFocusRef.current) {
            return;
        }
        shouldScrollToFocusRef.current = false;
        if (focusIndex === null || !osRef.current) {
            return;
        }
        const viewport = osRef.current.osInstance().elements().viewport;
        const viewportHeight = viewport.offsetHeight;
        const viewportScrollTop = viewport.scrollTop;
        const rowTop = focusIndex * VirtualRowHeight;
        const rowBottom = rowTop + VirtualRowHeight;

        if (rowTop - 30 < viewportScrollTop) {
            const topVal = Math.max(rowTop - 30, 0);
            viewport.scrollTo({ top: topVal });
        } else if (rowBottom + 5 > viewportScrollTop + viewportHeight) {
            const topVal = rowBottom - viewportHeight + 5;
            viewport.scrollTo({ top: Math.max(topVal, 0) });
        }
    }, [focusIndex]);

    // Click handler for multi-select
    const handleRowClick = useCallback(
        (e: React.MouseEvent, idx: number) => {
            const item = flatData[idx];
            if (!item || item.name === "..") {
                focusAndScroll(idx);
                setSelectedPaths(new Set());
                setLastClickedIndex(idx);
                return;
            }

            if (e.metaKey || e.ctrlKey) {
                // Cmd+Click: toggle selection
                setSelectedPaths((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.path)) {
                        next.delete(item.path);
                    } else {
                        next.add(item.path);
                    }
                    return next;
                });
                focusAndScroll(idx);
                setLastClickedIndex(idx);
            } else if (e.shiftKey && lastClickedIndex !== null) {
                // Shift+Click: range selection
                const start = Math.min(lastClickedIndex, idx);
                const end = Math.max(lastClickedIndex, idx);
                const newSelection = new Set<string>();
                for (let i = start; i <= end; i++) {
                    const fi = flatData[i];
                    if (fi && fi.name !== "..") {
                        newSelection.add(fi.path);
                    }
                }
                setSelectedPaths(newSelection);
                focusAndScroll(idx);
            } else {
                // Plain click: single select
                focusAndScroll(idx);
                setSelectedPaths(new Set());
                setLastClickedIndex(idx);
            }
        },
        [flatData, lastClickedIndex, focusAndScroll, setSelectedPaths, setLastClickedIndex]
    );

    const handleFileContextMenu = useCallback(
        async (e: any, finfo: FileInfo, idx: number) => {
            e.preventDefault();
            e.stopPropagation();
            if (finfo == null) return;

            const fileName = finfo.path.split("/").pop() ?? finfo.name ?? "";
            const relativePath =
                dirPath && finfo.path.startsWith(dirPath + "/") ? finfo.path.slice(dirPath.length + 1) : null;
            const { nextSelectedPaths, actionPaths } = resolveDirectoryContextSelection(selectedPaths, finfo);
            const actionPathSet = new Set(actionPaths);
            const contextItems = flatData.filter((item) => actionPathSet.has(item.path) && item.name !== "..");
            const itemsToOperate = contextItems.length > 0 ? contextItems : finfo.name !== ".." ? [finfo] : [];

            setFocusIndex(idx);
            setLastClickedIndex(idx);
            setSelectedPaths(new Set(nextSelectedPaths));

            const menuEntries = buildDirectoryItemMenuEntries({
                conn,
                finfo,
                locale: DirectoryMenuLocale,
                relativePath,
            });
            const menu = buildContextMenuItems(menuEntries, (id) => {
                switch (id) {
                    case "open-wave-directory":
                        return () => {
                            model.goHistory(finfo.path);
                        };
                    case "open-new-tab":
                        return () => {
                            getApi().openFileInNewTab(finfo.path, conn);
                        };
                    case "bookmark":
                        return () => {
                            const defaultLabel = finfo.name || finfo.path.split("/").pop() || "书签";
                            fireAndForget(() => model.addBookmark(finfo.path, defaultLabel));
                        };
                    case "rename":
                        return () => {
                            updateName(finfo.path, finfo.isdir);
                        };
                    case "copy":
                        return () => {
                            if (itemsToOperate.length > 0) {
                                setClipboard({
                                    paths: itemsToOperate.map((item) => item.path),
                                    names: itemsToOperate.map((item) => item.name),
                                    isDirs: itemsToOperate.map((item) => item.isdir),
                                    operation: "copy",
                                });
                            }
                        };
                    case "cut":
                        return () => {
                            if (itemsToOperate.length > 0) {
                                setClipboard({
                                    paths: itemsToOperate.map((item) => item.path),
                                    names: itemsToOperate.map((item) => item.name),
                                    isDirs: itemsToOperate.map((item) => item.isdir),
                                    operation: "cut",
                                });
                            }
                        };
                    case "copy-name":
                        return () => fireAndForget(() => writeClipboardText(fileName));
                    case "copy-path":
                        return () => fireAndForget(() => writeClipboardText(finfo.path));
                    case "copy-relative-path":
                        return () => fireAndForget(() => writeClipboardText(relativePath ?? ""));
                    case "delete":
                        return () => {
                            for (const item of itemsToOperate) {
                                handleFileDelete(model, item.path, false, setErrorMsg);
                            }
                            setSelectedPaths(new Set());
                        };
                    default:
                        return getOpenMenuActionHandler(id as OpenMenuActionId, conn, finfo);
                }
            });
            ContextMenuModel.showContextMenu(normalizeMenuSeparators(menu), e);
        },
        [
            conn,
            dirPath,
            flatData,
            model,
            selectedPaths,
            setClipboard,
            setEntryManagerProps,
            setErrorMsg,
            setFocusIndex,
            setLastClickedIndex,
            setSelectedPaths,
            updateName,
            writeClipboardText,
        ]
    );

    const overscan = 6;
    const totalRows = flatData.length;
    const startIndex = Math.max(0, Math.floor(scrollTop / VirtualRowHeight) - overscan);
    const endIndex = Math.min(
        totalRows,
        Math.ceil((scrollTop + viewportHeight) / VirtualRowHeight) + overscan
    );
    const visibleRows = flatData.slice(startIndex, endIndex);
    const paddingTop = startIndex * VirtualRowHeight;
    const paddingBottom = Math.max(0, (totalRows - endIndex) * VirtualRowHeight);
    const showSearchBar = searchOpen || searchQuery.length > 0;

    return (
        <div className="dir-tree">
            <div className="dir-tree-controls">
                {showSearchBar ? (
                    <div className="dir-tree-search">
                        <i className="fa fa-search" />
                        <input
                            ref={searchInputRef}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                    e.preventDefault();
                                    closeSearch();
                                }
                            }}
                            placeholder="搜索文件"
                        />
                        {searchQuery ? (
                            <button
                                className="dir-tree-control-button"
                                onClick={() => setSearchQuery("")}
                                title="清空搜索"
                            >
                                <i className="fa fa-times" />
                            </button>
                        ) : null}
                        <button
                            className={clsx("dir-tree-control-toggle", { active: searchMatchCase })}
                            onClick={() => setSearchMatchCase((prev) => !prev)}
                            title="区分大小写"
                        >
                            Aa
                        </button>
                        <button
                            className={clsx("dir-tree-control-toggle", { active: searchUseRegex })}
                            onClick={() => setSearchUseRegex((prev) => !prev)}
                            title="使用正则"
                        >
                            .*
                        </button>
                    </div>
                ) : null}
                <div className="dir-tree-actions">
                    <button
                        className="dir-tree-control-button"
                        onClick={() => {
                            if (showSearchBar) {
                                closeSearch();
                                return;
                            }
                            setSearchOpen(true);
                        }}
                        title={showSearchBar ? "收起搜索" : "搜索"}
                    >
                        <i className="fa fa-search" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={() => model.triggerRefresh()}
                        title="刷新"
                    >
                        <i className="fa fa-rotate-right" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={openTerminalHere}
                        title="在此处打开终端"
                    >
                        <i className="fa fa-terminal" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={() => startNewItem(false)}
                        title="新建文件"
                    >
                        <i className="fa fa-file" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={() => startNewItem(true)}
                        title="新建文件夹"
                    >
                        <i className="fa fa-folder" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={collapseAll}
                        title="全部折叠"
                    >
                        <i className="fa fa-compress" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={handleViewOptionsMenu}
                        title="视图选项"
                    >
                        <i className="fa fa-sliders" />
                    </button>
                </div>
            </div>
            <OverlayScrollbarsComponent
                options={{ scrollbars: { autoHide: "leave" } }}
                className="dir-tree-scroll"
                ref={osRef}
            >
                <div className="dir-tree-body" ref={bodyRef}>
                    <div style={{ height: paddingTop }} />
                    {visibleRows.map((item, localIdx) => {
                        const idx = startIndex + localIdx;
                        return (
                            <TreeRow
                                key={item.path + "-" + idx}
                                model={model}
                                currentDirPath={dirPath}
                                item={item}
                                idx={idx}
                                focusIndex={focusIndex}
                                setFocusIndex={setFocusIndex}
                                toggleExpand={toggleExpand}
                                getIconFromMimeType={getIconFromMimeType}
                                getIconColor={getIconColor}
                                handleFileContextMenu={handleFileContextMenu}
                                onFileDrop={onFileDrop}
                                onExternalFileDrop={onExternalFileDrop}
                                isEditing={editingItem?.path === item.path}
                                onEditComplete={(newName) => {
                                    if (editingItem?.isNew) {
                                        const newPath = item.path.replace(/[^/]+$/, newName);
                                        pendingFocusPathRef.current = newPath;
                                        if (editingItem.isDir) {
                                            fireAndForget(async () => {
                                                await RpcApi.FileMkdirCommand(TabRpcClient, {
                                                    info: {
                                                        path: await model.formatRemoteUri(newPath, globalStore.get),
                                                    },
                                                });
                                                model.refreshCallback?.();
                                            });
                                        } else {
                                            fireAndForget(async () => {
                                                await RpcApi.FileCreateCommand(
                                                    TabRpcClient,
                                                    {
                                                        info: {
                                                            path: await model.formatRemoteUri(newPath, globalStore.get),
                                                        },
                                                    },
                                                    null
                                                );
                                                model.refreshCallback?.();
                                            });
                                        }
                                    } else {
                                        const newPath = item.path.replace(/[^/]+$/, newName);
                                        if (newName !== item.name) {
                                            pendingFocusPathRef.current = newPath;
                                            handleRename(model, item.path, newPath, item.isdir, setErrorMsg);
                                        }
                                    }
                                    setEditingItem(null);
                                    setPendingNewItem(null);
                                }}
                                onEditCancel={() => { setEditingItem(null); setPendingNewItem(null); }}
                                isSelected={selectedPaths.has(item.path)}
                                isCut={clipboard?.operation === "cut" && clipboard.paths.includes(item.path)}
                                onRowClick={handleRowClick}
                                highlightQuery={searchQuery}
                                highlightMatchCase={searchMatchCase}
                                highlightUseRegex={searchUseRegex}
                                showIcons={prefs.showIcons}
                            />
                        );
                    })}
                    <div style={{ height: paddingBottom }} />
                    {totalRows === 0 && (
                        <div className="dir-tree-empty">
                            {searchQuery ? "没有匹配项" : "没有文件"}
                        </div>
                    )}
                </div>
            </OverlayScrollbarsComponent>
        </div>
    );
}

interface TreeRowProps {
    model: PreviewModel;
    currentDirPath: string;
    item: TreeFileInfo;
    idx: number;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    toggleExpand: (path: string, isDir: boolean, isNestParent: boolean) => void;
    getIconFromMimeType: (mimeType: string) => string;
    getIconColor: (mimeType: string) => string;
    handleFileContextMenu: (e: any, finfo: FileInfo, idx: number) => Promise<void>;
    onFileDrop: (draggedFile: DraggedFile, targetPath: string) => Promise<void>;
    onExternalFileDrop: (files: File[], targetPath: string) => Promise<void>;
    isEditing: boolean;
    onEditComplete: (newName: string) => void;
    onEditCancel: () => void;
    isSelected: boolean;
    isCut: boolean;
    onRowClick: (e: React.MouseEvent, idx: number) => void;
    highlightQuery: string;
    highlightMatchCase: boolean;
    highlightUseRegex: boolean;
    showIcons: boolean;
}

function TreeRow({
    model,
    currentDirPath,
    item,
    idx,
    focusIndex,
    setFocusIndex,
    toggleExpand,
    getIconFromMimeType,
    getIconColor,
    handleFileContextMenu,
    onFileDrop,
    onExternalFileDrop,
    isEditing,
    onEditComplete,
    onEditCancel,
    isSelected,
    isCut,
    onRowClick,
    highlightQuery,
    highlightMatchCase,
    highlightUseRegex,
    showIcons,
}: TreeRowProps) {
    const connection = useAtomValue(model.connectionImmediate);

    const dragItem: DraggedFile = {
        relName: item.name,
        absParent: currentDirPath,
        uri: formatRemoteUri(item.path, connection),
        isDir: item.isdir,
    };

    const [{ isDragging }, drag] = useDrag(
        () => ({
            type: "FILE_ITEM",
            canDrag: item.name !== ".." && !isEditing,
            item: () => dragItem,
            collect: (monitor) => ({
                isDragging: monitor.isDragging(),
            }),
        }),
        [dragItem, item.name, isEditing]
    );

    const [{ isOver, canDrop }, drop] = useDrop(
        () => ({
            accept: ["FILE_ITEM", NativeTypes.FILE],
            canDrop: (draggedItem: any, monitor) => {
                if (monitor.getItemType() === NativeTypes.FILE) {
                    return item.isdir && item.name !== "..";
                }
                // Internal drag
                if (!item.isdir) return false;
                if (item.name === "..") return false;
                if (draggedItem.uri === formatRemoteUri(item.path, connection)) return false;
                if (draggedItem.absParent === item.path) return false;
                return true;
            },
            drop: async (draggedItem: any, monitor) => {
                if (monitor.getItemType() === NativeTypes.FILE) {
                    const files: File[] = draggedItem.files;
                    await onExternalFileDrop(files, item.path);
                } else {
                    await onFileDrop(draggedItem as DraggedFile, item.path);
                }
            },
            collect: (monitor) => ({
                isOver: monitor.isOver(),
                canDrop: monitor.canDrop(),
            }),
        }),
        [item, connection, onFileDrop, onExternalFileDrop]
    );

    const dragDropRef = useCallback(
        (node: HTMLDivElement | null) => {
            drag(node);
            drop(node);
        },
        [drag, drop]
    );

    const handleClick = useCallback(
        (e: React.MouseEvent) => {
            onRowClick(e, idx);
        },
        [idx, onRowClick]
    );

    const handleDoubleClick = useCallback(() => {
        if (item.isdir && item.name !== ".." && !item.blocksExpansion) {
            // Double-click on directory: expand/collapse
            toggleExpand(item.path, true, item.isNestParent ?? false);
        } else if (item.isNestParent) {
            toggleExpand(item.path, false, true);
        } else if (item.name === "..") {
            // Double-click on "..": navigate to parent
            model.goHistory(item.path);
        } else {
            // Double-click on file: open in a right-side split
            fireAndForget(async () => {
                await createBlockAtRightmost(
                    {
                        meta: {
                            view: "preview",
                            file: item.path,
                            connection: connection,
                        },
                    }
                );
            });
        }
    }, [item, model, toggleExpand, connection]);

    const handleChevronClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            toggleExpand(item.path, item.isdir, item.isNestParent ?? false);
        },
        [item, toggleExpand]
    );

    const handleNativeDragStartCapture = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            // Populate native drag payload so external apps (e.g. Ghostty) can receive the file path.
            if (!e.dataTransfer || item.name === ".." || !item.path) {
                return;
            }
            // Prefer shell-escaped text so dropping into terminals inserts a runnable path.
            e.dataTransfer.setData("text/plain", shellQuote([item.path]));
            const isPosixPath = item.path.startsWith("/");
            const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(item.path);
            if (isPosixPath || isWindowsPath) {
                const normalizedPath = isWindowsPath ? `/${item.path.replace(/\\/g, "/")}` : item.path;
                e.dataTransfer.setData("text/uri-list", `file://${encodeURI(normalizedPath)}`);
            }
            e.dataTransfer.effectAllowed = "copyMove";
        },
        [item.name, item.path]
    );

    // Render chevron for directories or nested files
    const renderChevron = () => {
        const isExpandable = !item.blocksExpansion && ((item.isdir && item.name !== "..") || item.isNestParent);
        if (!isExpandable || !item.name) {
            return <span className="dir-tree-chevron-placeholder" />;
        }

        if (item.isLoading) {
            return <i className="fa fa-spinner fa-spin dir-tree-chevron" />;
        }

        return (
            <i
                className={clsx("fa dir-tree-chevron", {
                    "fa-chevron-right": !item.isExpanded,
                    "fa-chevron-down": item.isExpanded,
                })}
                onClick={handleChevronClick}
            />
        );
    };

    // Render file/folder icon
    const renderIcon = () => {
        if (!showIcons) {
            return <span className="dir-tree-icon-placeholder" />;
        }
        if (item.isdir) {
            return (
                <i
                    className={clsx("fa fa-fw", {
                        "fa-folder-open": item.isExpanded,
                        "fa-folder": !item.isExpanded,
                    })}
                    style={{ color: "#dcb67a" }}
                />
            );
        }
        return (
            <i
                className={getIconFromMimeType(item.mimetype ?? "")}
                style={{ color: getIconColor(item.mimetype ?? "") }}
            />
        );
    };

    const renderName = () => {
        const name = item.displayName ?? item.name ?? "";
        if (!highlightQuery) {
            return <span className="dir-tree-name">{name}</span>;
        }

        if (highlightUseRegex) {
            try {
                const re = new RegExp(highlightQuery, highlightMatchCase ? "" : "i");
                const match = re.exec(name);
                if (!match) return <span className="dir-tree-name">{name}</span>;
                const start = match.index;
                const end = start + match[0].length;
                return (
                    <span className="dir-tree-name">
                        {name.slice(0, start)}
                        <span className="dir-tree-match">{name.slice(start, end)}</span>
                        {name.slice(end)}
                    </span>
                );
            } catch {
                return <span className="dir-tree-name">{name}</span>;
            }
        }

        const haystack = highlightMatchCase ? name : name.toLowerCase();
        const needle = highlightMatchCase ? highlightQuery : highlightQuery.toLowerCase();
        const idx = haystack.indexOf(needle);
        if (idx === -1) return <span className="dir-tree-name">{name}</span>;
        const end = idx + needle.length;
        return (
            <span className="dir-tree-name">
                {name.slice(0, idx)}
                <span className="dir-tree-match">{name.slice(idx, end)}</span>
                {name.slice(end)}
            </span>
        );
    };

    return (
        <div
            className={clsx("dir-tree-row", {
                focused: focusIndex === idx,
                selected: isSelected,
                "cut-pending": isCut,
                dragging: isDragging,
                "drop-target": isOver && canDrop,
                "drop-not-allowed": isOver && !canDrop,
                editing: isEditing,
            })}
            data-rowindex={idx}
            style={{ paddingLeft: `${8 + item.depth * 16}px` }}
            onClick={isEditing ? undefined : handleClick}
            onDoubleClick={isEditing ? undefined : handleDoubleClick}
            onContextMenu={isEditing ? undefined : (e) => handleFileContextMenu(e, item, idx)}
            onDragStartCapture={handleNativeDragStartCapture}
            ref={dragDropRef}
        >
            {renderChevron()}
            {renderIcon()}
            {isEditing ? (
                <InlineEditInput
                    initialValue={item.name}
                    isDir={item.isdir}
                    onComplete={onEditComplete}
                    onCancel={onEditCancel}
                />
            ) : (
                renderName()
            )}
        </div>
    );
}

interface DirectoryPreviewProps {
    model: PreviewModel;
}

function DirectoryPreview({ model }: DirectoryPreviewProps) {
    const [focusIndex, setFocusIndex] = useState(0);
    const [unfilteredData, setUnfilteredData] = useState<FileInfo[]>([]);
    const unfilteredDataRef = useRef(unfilteredData);
    const rootReconcileInFlightRef = useRef(false);
    const [stableDirInfo, setStableDirInfo] = useState<FileInfo | null>(null);
    const showHiddenFiles = useAtomValue(model.showHiddenFiles);
    const [selectedPath, setSelectedPath] = useState("");
    const [refreshVersion, setRefreshVersion] = useAtom(model.refreshVersion);
    const conn = useAtomValue(model.connection);
    const connection = useAtomValue(model.connectionImmediate);
    const blockData = useAtomValue(model.blockAtom);
    const loadableFileInfo = useAtomValue(model.loadableFileInfo);
    const finfo = loadableFileInfo.state === "hasData" ? loadableFileInfo.data : stableDirInfo;
    const dirPath = finfo?.path;
    const dirPathValue = dirPath ?? "";
    const homeDir = useMemo(() => getApi().getHomeDir(), []);
    const normalizedDirPath = useMemo(
        () => normalizeDirectoryWatchPath(dirPathValue, homeDir),
        [dirPathValue, homeDir]
    );
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const prefsMeta = (blockData?.meta?.[PreviewPrefsMetaKey] ?? {}) as Partial<PreviewPrefs>;
    const prefsMetaJson = useMemo(() => JSON.stringify(prefsMeta), [prefsMeta]);
    const [prefs, setPrefs] = useState<Required<PreviewPrefs>>(() => ({
        ...DefaultPreviewPrefs,
        ...prefsMeta,
    }));
    useEffect(() => {
        if (loadableFileInfo.state === "hasData") {
            setStableDirInfo(loadableFileInfo.data);
        }
    }, [loadableFileInfo]);
    useEffect(() => {
        unfilteredDataRef.current = unfilteredData;
    }, [unfilteredData]);
    const updatePrefs = useCallback((patch: Partial<PreviewPrefs>) => {
        setPrefs((prev) => ({ ...prev, ...patch }));
    }, []);
    const prefsJson = useMemo(() => JSON.stringify(prefs), [prefs]);

    // Multi-select state
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

    // Internal clipboard
    const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
    const [rootRefreshVersion, setRootRefreshVersion] = useState(0);
    const [autoRefreshRequest, setAutoRefreshRequest] = useState<{ id: number; dirs: string[] }>({
        id: 0,
        dirs: [],
    });
    const queuedRefreshDirsRef = useRef<Set<string>>(new Set());
    const queuedRefreshTimerRef = useRef<number | null>(null);

    useEffect(() => {
        model.refreshCallback = () => {
            setRefreshVersion((refreshVersion) => refreshVersion + 1);
        };
        return () => {
            model.refreshCallback = null;
        };
    }, [setRefreshVersion]);

    const flushQueuedDirRefreshes = useCallback(() => {
        queuedRefreshTimerRef.current = null;
        const changedDirs = Array.from(queuedRefreshDirsRef.current);
        queuedRefreshDirsRef.current.clear();
        if (changedDirs.length === 0) {
            return;
        }
        const childDirSet = new Set<string>();
        let refreshRoot = false;
        for (const changedDir of changedDirs) {
            if (changedDir === normalizedDirPath) {
                refreshRoot = true;
            } else {
                childDirSet.add(changedDir);
            }
        }
        if (refreshRoot) {
            setRootRefreshVersion((v) => v + 1);
        }
        const childDirs = Array.from(childDirSet);
        if (childDirs.length > 0) {
            setAutoRefreshRequest((prev) => ({ id: prev.id + 1, dirs: childDirs }));
        }
    }, [normalizedDirPath]);

    const queueDirRefresh = useCallback(
        (changedDir?: string) => {
            const normalizedChangedDir = normalizeDirectoryWatchPath(changedDir, homeDir);
            if (!normalizedChangedDir) {
                setRootRefreshVersion((v) => v + 1);
                return;
            }
            queuedRefreshDirsRef.current.add(normalizedChangedDir);
            if (queuedRefreshTimerRef.current != null) {
                return;
            }
            queuedRefreshTimerRef.current = window.setTimeout(flushQueuedDirRefreshes, AutoRefreshCoalesceMs);
        },
        [flushQueuedDirRefreshes, homeDir]
    );

    useEffect(() => {
        return () => {
            if (queuedRefreshTimerRef.current != null) {
                window.clearTimeout(queuedRefreshTimerRef.current);
                queuedRefreshTimerRef.current = null;
            }
            queuedRefreshDirsRef.current.clear();
        };
    }, []);

    useEffect(() => {
        if (queuedRefreshTimerRef.current != null) {
            window.clearTimeout(queuedRefreshTimerRef.current);
            queuedRefreshTimerRef.current = null;
        }
        queuedRefreshDirsRef.current.clear();
    }, [dirPath]);

    useEffect(() => {
        const next = { ...DefaultPreviewPrefs, ...prefsMeta };
        const nextJson = JSON.stringify(next);
        setPrefs((prev) => {
            if (JSON.stringify(prev) === nextJson) {
                return prev;
            }
            return next;
        });
    }, [prefsMetaJson]);

    useEffect(() => {
        const blockId = blockData?.oid;
        if (!blockId) return;
        if (prefsJson === prefsMetaJson) return;
        fireAndForget(() =>
            ObjectService.UpdateObjectMeta(
                WOS.makeORef("block", blockId),
                {
                    [PreviewPrefsMetaKey]: prefs,
                } as MetaType
            )
        );
    }, [prefsJson, prefsMetaJson, blockData?.oid]);

    // Subscribe to directory watch events for automatic refresh
    useEffect(() => {
        const blockId = blockData?.oid;
        if (!dirPath || !blockId) {
            return;
        }
        const dirWatchRpcOpts = isLocalConnName(connection) ? undefined : { route: makeConnRoute(connection) };

        fireAndForget(async () => {
            try {
                await RpcApi.DirWatchSubscribeCommand(TabRpcClient, {
                    dirpath: dirPath,
                    blockid: blockId,
                }, dirWatchRpcOpts);
            } catch (e) {
                console.log("Failed to subscribe to directory watch:", e);
            }
        });

        // Listen for directory change events
        const unsub = waveEventSubscribe({
            eventType: "dirwatch",
            scope: `block:${blockId}`,
            handler: (event) => {
                const data = event.data as { dirpath?: string; event?: string; name?: string } | null;
                if (isInternalDirectoryProbeName(data?.name)) {
                    return;
                }
                if (shouldIgnoreVolumesDirectoryWatchEvent(dirPath, data?.dirpath, data?.name)) {
                    return;
                }
                if (!shouldRefreshDirectoryForEvent(data?.event, prefs.sortMode)) {
                    return;
                }
                queueDirRefresh(data?.dirpath);
            },
        });

        return () => {
            unsub();
            fireAndForget(async () => {
                try {
                    await RpcApi.DirWatchUnsubscribeCommand(TabRpcClient, {
                        dirpath: dirPath,
                        blockid: blockId,
                    }, dirWatchRpcOpts);
                } catch (e) {
                    // Ignore errors on cleanup
                }
            });
        };
    }, [connection, dirPath, blockData?.oid, prefs.sortMode, queueDirRefresh]);

    const readRootDirectoryEntries = useCallback(async (): Promise<FileInfo[]> => {
        if (!dirPath) {
            return [];
        }
        const file = await RpcApi.FileReadCommand(
            TabRpcClient,
            {
                info: {
                    path: await model.formatRemoteUri(dirPath, globalStore.get),
                },
            },
            null
        );
        return filterInternalProbeEntries(file.entries ?? []);
    }, [dirPath, model]);

    useEffect(
        () =>
            fireAndForget(async () => {
                let entries: FileInfo[] = [];
                try {
                    entries = await readRootDirectoryEntries();
                } catch (e) {
                    setErrorMsg({
                        status: "无法读取目录",
                        text: `${e}`,
                    });
                }
                setUnfilteredData(entries);
            }),
        [conn, dirPath, refreshVersion, rootRefreshVersion, readRootDirectoryEntries]
    );

    useEffect(() => {
        if (!dirPath) {
            return;
        }
        const intervalId = window.setInterval(() => {
            if (rootReconcileInFlightRef.current) {
                return;
            }
            rootReconcileInFlightRef.current = true;
            fireAndForget(async () => {
                try {
                    const nextEntries = await readRootDirectoryEntries();
                    const nextSignature = makeDirectoryEntriesSignature(nextEntries);
                    const prevSignature = makeDirectoryEntriesSignature(unfilteredDataRef.current);
                    if (nextSignature !== prevSignature) {
                        setUnfilteredData(nextEntries);
                    }
                } catch {
                    // keep existing data; manual refresh/error overlay still handles hard failures
                } finally {
                    rootReconcileInFlightRef.current = false;
                }
            });
        }, DirectoryReconcileFallbackIntervalMs);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [dirPath, readRootDirectoryEntries]);

    const filteredData = useMemo(
        () =>
            unfilteredData?.filter((fileInfo) => {
                if (fileInfo.name == null) {
                    console.log("fileInfo.name is null", fileInfo);
                    return false;
                }
                if (!showHiddenFiles && fileInfo.name.startsWith(".")) {
                    return false;
                }
                return true;
            }) ?? [],
        [unfilteredData, showHiddenFiles]
    );

    const entryManagerPropsAtom = useState(
        atom<EntryManagerOverlayProps>(null) as PrimitiveAtom<EntryManagerOverlayProps>
    )[0];
    const [entryManagerProps, setEntryManagerProps] = useAtom(entryManagerPropsAtom);

    const { refs, floatingStyles, context } = useFloating({
        open: !!entryManagerProps,
        onOpenChange: () => setEntryManagerProps(undefined),
        middleware: [offset(({ rects }) => -rects.reference.height / 2 - rects.floating.height / 2)],
    });

    const handleDropCopy = useCallback(
        async (data: CommandFileCopyData, isDir: boolean) => {
            try {
                await RpcApi.FileCopyCommand(TabRpcClient, data, { timeout: data.opts.timeout });
            } catch (e) {
                console.warn("Copy failed:", e);
                const copyError = `${e}`;
                const allowRetry = copyError.includes(overwriteError) || copyError.includes(mergeError);
                let errorMsg: ErrorMsg;
                if (allowRetry) {
                    errorMsg = {
                        status: "确认覆盖文件",
                        text: "本次复制会覆盖已存在的文件。确定继续吗？",
                        level: "warning",
                        buttons: [
                            {
                                text: "覆盖后复制",
                                onClick: async () => {
                                    data.opts.overwrite = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                            {
                                text: "合并同步",
                                onClick: async () => {
                                    data.opts.merge = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                        ],
                    };
                } else {
                    errorMsg = {
                        status: "复制失败",
                        text: copyError,
                        level: "error",
                    };
                }
                setErrorMsg(errorMsg);
            }
            model.refreshCallback();
        },
        [model.refreshCallback]
    );

    const handleDropMove = useCallback(
        async (data: CommandFileCopyData, isDir: boolean) => {
            try {
                await RpcApi.FileMoveCommand(TabRpcClient, data, { timeout: data.opts.timeout });
            } catch (e) {
                console.warn("Move failed:", e);
                const moveError = `${e}`;
                const alreadyExists = moveError.includes("already exists");
                const allowRetry =
                    alreadyExists || moveError.includes(overwriteError) || moveError.includes(mergeError);
                let errorMsg: ErrorMsg;
                if (allowRetry) {
                    errorMsg = {
                        status: "确认覆盖",
                        text: "目标已存在，是否覆盖？",
                        level: "warning",
                        buttons: [
                            {
                                text: "覆盖",
                                onClick: async () => {
                                    data.opts.overwrite = true;
                                    await handleDropMove(data, isDir);
                                },
                            },
                        ],
                    };
                } else {
                    errorMsg = {
                        status: "移动失败",
                        text: moveError,
                        level: "error",
                    };
                }
                setErrorMsg(errorMsg);
            }
            model.refreshCallback();
        },
        [model.refreshCallback]
    );

    const onFileDrop = useCallback(
        async (draggedFile: DraggedFile, targetPath: string) => {
            const timeoutYear = 31536000000; // one year
            const opts: FileCopyOpts = {
                timeout: timeoutYear,
            };
            // Target path should be: targetFolder + sourceFileName
            const fullTargetPath = targetPath + "/" + draggedFile.relName;
            const desturi = await model.formatRemoteUri(fullTargetPath, globalStore.get);
            const data: CommandFileCopyData = {
                srcuri: draggedFile.uri,
                desturi,
                opts: { ...opts, recursive: draggedFile.isDir },
            };
            await handleDropMove(data, draggedFile.isDir);
        },
        [model.formatRemoteUri, handleDropMove]
    );

    // Handle paste from internal clipboard
    const handlePaste = useCallback(
        async (cb: FileClipboard, targetDir: string) => {
            const timeoutYear = 31536000000;
            for (let i = 0; i < cb.paths.length; i++) {
                const srcPath = cb.paths[i];
                const name = cb.names[i];
                const isDir = cb.isDirs[i];
                const srcuri = await model.formatRemoteUri(srcPath + (isDir ? "/" : ""), globalStore.get);
                const desturi = await model.formatRemoteUri(targetDir + "/" + name, globalStore.get);
                const data: CommandFileCopyData = {
                    srcuri,
                    desturi,
                    opts: { timeout: timeoutYear, recursive: isDir },
                };
                if (cb.operation === "cut") {
                    await handleDropMove(data, isDir);
                } else {
                    await handleDropCopy(data, isDir);
                }
            }
            if (cb.operation === "cut") {
                setClipboard(null);
            }
        },
        [model.formatRemoteUri, handleDropMove, handleDropCopy]
    );

    const pasteFromClipboard = useCallback(
        async (targetDir: string, e?: ClipboardEvent): Promise<boolean> => {
            if (!targetDir) {
                return false;
            }
            if (clipboard) {
                await handlePaste(clipboard, targetDir);
                return true;
            }

            const files = await getApi().readClipboardFiles();
            if (files.length > 0) {
                const errors: string[] = [];
                for (const rawSrcPath of files) {
                    const srcPath = normalizeClipboardFsPath(rawSrcPath);
                    const name = srcPath.split("/").filter(Boolean).pop();
                    if (!name) {
                        errors.push(`无法确定剪贴板项目名称：${rawSrcPath}`);
                        continue;
                    }
                    const desturi = await model.formatRemoteUri(targetDir + "/" + name, globalStore.get);
                    try {
                        await RpcApi.FileCopyCommand(TabRpcClient, {
                            srcuri: "wsh://local" + srcPath,
                            desturi,
                            opts: { timeout: 31536000000, recursive: true },
                        });
                    } catch (err) {
                        console.warn("Paste from system clipboard failed:", err);
                        errors.push(`${name}: ${err}`);
                    }
                }
                if (errors.length > 0) {
                    setErrorMsg({
                        status: "粘贴失败",
                        text: errors.join("\n"),
                        level: "error",
                    });
                }
                model.refreshCallback?.();
                return true;
            }

            const clipboardItems = await extractAllClipboardData(e);
            const images = clipboardItems.flatMap((item) => (item.image ? [item.image] : []));
            if (images.length === 0) {
                return false;
            }

            for (const [index, image] of images.entries()) {
                const fileName = makeClipboardImageName(image, index);
                const filePath = await model.formatRemoteUri(targetDir + "/" + fileName, globalStore.get);
                const arrayBuffer = await image.arrayBuffer();
                await RpcApi.FileWriteCommand(TabRpcClient, {
                    info: { path: filePath },
                    data64: base64.fromByteArray(new Uint8Array(arrayBuffer)),
                });
            }
            model.refreshCallback?.();
            return true;
        },
        [clipboard, handlePaste, model, setErrorMsg]
    );

    // Handle external file drop (from Finder)
    const onExternalFileDrop = useCallback(
        async (files: File[], targetPath: string) => {
            const timeoutYear = 31536000000;
            for (const file of files) {
                const srcPath = (file as any).path;
                if (srcPath) {
                    const desturi = await model.formatRemoteUri(
                        targetPath + "/" + file.name, globalStore.get
                    );
                    try {
                        await RpcApi.FileCopyCommand(TabRpcClient, {
                            srcuri: "wsh://local" + srcPath,
                            desturi,
                            opts: { timeout: timeoutYear },
                        });
                    } catch (e) {
                        console.warn("External file drop failed:", e);
                    }
                }
            }
            model.refreshCallback?.();
        },
        [model.formatRemoteUri, model.refreshCallback]
    );

    const [, drop] = useDrop(
        () => ({
            accept: ["FILE_ITEM", NativeTypes.FILE],
            canDrop: (draggedItem: any, monitor) => {
                if (monitor.getItemType() === NativeTypes.FILE) {
                    return true;
                }
                // Internal drag
                if (monitor.isOver({ shallow: false }) && draggedItem.absParent !== dirPath) {
                    return true;
                }
                return false;
            },
            drop: async (draggedItem: any, monitor) => {
                if (!monitor.didDrop()) {
                    if (monitor.getItemType() === NativeTypes.FILE) {
                        const files: File[] = draggedItem.files;
                        await onExternalFileDrop(files, dirPath);
                    } else {
                        const draggedFile = draggedItem as DraggedFile;
                        const timeoutYear = 31536000000;
                        const opts: FileCopyOpts = { timeout: timeoutYear };
                        const fullTargetPath = dirPath + "/" + draggedFile.relName;
                        const desturi = await model.formatRemoteUri(fullTargetPath, globalStore.get);
                        const data: CommandFileCopyData = {
                            srcuri: draggedFile.uri,
                            desturi,
                            opts,
                        };
                        await handleDropMove(data, draggedFile.isDir);
                    }
                }
            },
        }),
        [dirPath, model.formatRemoteUri, handleDropMove, onExternalFileDrop]
    );

    useEffect(() => {
        drop(refs.reference);
    }, [refs.reference]);

    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

    // Inline new item request state (replaces overlay-based creation)
    const [newItemRequest, setNewItemRequest] = useState<{ isDir: boolean; parentPath?: string } | null>(null);
    const clearNewItemRequest = useCallback(() => setNewItemRequest(null), []);

    const handleFileContextMenu = useCallback(
        (e: any) => {
            e.preventDefault();
            e.stopPropagation();
            if (finfo == null) return;
            const menuEntries = buildDirectoryBackgroundMenuEntries({
                conn,
                finfo,
                locale: DirectoryMenuLocale,
                clipboardCount: clipboard?.paths.length,
            });
            const menu = buildContextMenuItems(menuEntries, (id) => {
                switch (id) {
                    case "new-file":
                        return () => setNewItemRequest({ isDir: false, parentPath: dirPath });
                    case "new-folder":
                        return () => setNewItemRequest({ isDir: true, parentPath: dirPath });
                    case "paste":
                        return () => fireAndForget(() => pasteFromClipboard(dirPathValue));
                    default:
                        return getOpenMenuActionHandler(id as OpenMenuActionId, conn, finfo);
                }
            });
            ContextMenuModel.showContextMenu(normalizeMenuSeparators(menu), e);
        },
        [clipboard, conn, dirPathValue, finfo, pasteFromClipboard]
    );

    return (
        <Fragment>
            <div
                ref={refs.setReference}
                className="dir-table-container"
                {...getReferenceProps()}
                onContextMenu={(e) => handleFileContextMenu(e)}
                onClick={() => setEntryManagerProps(undefined)}
            >
                <DirectoryTree
                    model={model}
                    data={filteredData}
                    focusIndex={focusIndex}
                    setFocusIndex={setFocusIndex}
                    setSelectedPath={setSelectedPath}
                    entryManagerOverlayPropsAtom={entryManagerPropsAtom}
                    onFileDrop={onFileDrop}
                    prefs={prefs}
                    updatePrefs={updatePrefs}
                    selectedPaths={selectedPaths}
                    setSelectedPaths={setSelectedPaths}
                    lastClickedIndex={lastClickedIndex}
                    setLastClickedIndex={setLastClickedIndex}
                    clipboard={clipboard}
                    setClipboard={setClipboard}
                    onPaste={handlePaste}
                    onPasteFromClipboard={pasteFromClipboard}
                    dirPath={dirPathValue}
                    onExternalFileDrop={onExternalFileDrop}
                    newItemRequest={newItemRequest}
                    onNewItemHandled={clearNewItemRequest}
                    autoRefreshRequest={autoRefreshRequest}
                />
            </div>
            {entryManagerProps && (
                <EntryManagerOverlay
                    {...entryManagerProps}
                    forwardRef={refs.setFloating}
                    style={floatingStyles}
                    getReferenceProps={getFloatingProps}
                    onCancel={() => setEntryManagerProps(undefined)}
                />
            )}
        </Fragment>
    );
}

export { DirectoryPreview };
