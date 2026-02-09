// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import {
    atoms,
    createBlock,
    getApi,
    globalStore,
} from "@/app/store/global";
import { ObjectService } from "@/app/store/services";
import { waveEventSubscribe } from "@/app/store/wps";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { checkKeyPressed, isCharacterKeyEvent } from "@/util/keyutil";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { addOpenMenuItems } from "@/util/previewutil";
import { fireAndForget } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import { offset, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import clsx from "clsx";
import { PrimitiveAtom, atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { OverlayScrollbarsComponent, OverlayScrollbarsComponentRef } from "overlayscrollbars-react";
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { NativeTypes } from "react-dnd-html5-backend";
import { quote as shellQuote } from "shell-quote";
import "./directorypreview.scss";
import { EntryManagerOverlay, EntryManagerOverlayProps, EntryManagerType } from "./entry-manager";
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

// Internal clipboard for copy/cut operations
interface FileClipboard {
    paths: string[];
    names: string[];
    isDirs: boolean[];
    operation: "copy" | "cut";
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
    dirPath: string;
    // External file drop
    onExternalFileDrop: (files: File[], targetPath: string) => Promise<void>;
    // Inline new item creation from parent
    newItemRequest: { isDir: boolean; parentPath?: string } | null;
    onNewItemHandled: () => void;
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
    dirPath,
    onExternalFileDrop,
    newItemRequest,
    onNewItemHandled,
}: DirectoryTreeProps) {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const conn = useAtomValue(model.connection);
    const blockData = useAtomValue(model.blockAtom);
    const showHiddenFiles = useAtomValue(model.showHiddenFiles);
    const setShowHiddenFiles = useSetAtom(model.showHiddenFiles);
    const osRef = useRef<OverlayScrollbarsComponentRef>(null);
    const bodyRef = useRef<HTMLDivElement>(null);

    // Track expanded directories
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    // Track inline editing state: { path: string, isNew: boolean, isDir: boolean }
    const [editingItem, setEditingItem] = useState<{ path: string; isNew: boolean; isDir: boolean } | null>(null);
    // Track loaded children for each directory
    const [childrenCache, setChildrenCache] = useState<Map<string, FileInfo[]>>(new Map());
    // Track loading state
    const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
    // Search/filter state
    const [searchQuery, setSearchQuery] = useState("");
    const [searchMatchCase, setSearchMatchCase] = useState(false);
    const [searchUseRegex, setSearchUseRegex] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    // Quick type-to-filter
    const [filterText, setFilterText] = useState("");
    const filterTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
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

    // Listen to refreshVersion and reload expanded directories when it changes
    const refreshVersion = useAtomValue(model.refreshVersion);
    useEffect(() => {
        // Reload children for all expanded paths (keep old data visible until new data arrives)
        const reloadExpandedDirs = async () => {
            for (const dp of expandedPaths) {
                try {
                    const file = await RpcApi.FileReadCommand(
                        TabRpcClient,
                        {
                            info: {
                                path: await model.formatRemoteUri(dp, globalStore.get),
                            },
                        },
                        null
                    );
                    const entries = file.entries ?? [];
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
            }
        };
        if (expandedPaths.size > 0) {
            reloadExpandedDirs();
        }
    }, [refreshVersion]);

    // Subscribe to directory watch for expanded subdirectories
    const watchedExpandedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const blockId = blockData?.oid;
        if (!blockId || conn) return;

        const currentExpanded = new Set(expandedPaths);
        const prevWatched = watchedExpandedRef.current;

        for (const dp of currentExpanded) {
            if (dp !== dirPath && !prevWatched.has(dp)) {
                fireAndForget(async () => {
                    try {
                        await RpcApi.DirWatchSubscribeCommand(TabRpcClient, { dirpath: dp, blockid: blockId });
                    } catch (e) { /* ignore */ }
                });
            }
        }
        for (const dp of prevWatched) {
            if (!currentExpanded.has(dp)) {
                fireAndForget(async () => {
                    try {
                        await RpcApi.DirWatchUnsubscribeCommand(TabRpcClient, { dirpath: dp, blockid: blockId });
                    } catch (e) { /* ignore */ }
                });
            }
        }
        watchedExpandedRef.current = currentExpanded;

        return () => {
            for (const dp of currentExpanded) {
                if (dp !== dirPath) {
                    fireAndForget(async () => {
                        try {
                            await RpcApi.DirWatchUnsubscribeCommand(TabRpcClient, { dirpath: dp, blockid: blockId });
                        } catch (e) { /* ignore */ }
                    });
                }
            }
        };
    }, [expandedPaths, blockData?.oid, conn, dirPath]);

    const setEntryManagerProps = useSetAtom(entryManagerOverlayPropsAtom);

    const getIconFromMimeType = useCallback(
        (mimeType: string): string => {
            while (mimeType.length > 0) {
                const icon = fullConfig.mimetypes?.[mimeType]?.icon ?? null;
                if (isIconValid(icon)) {
                    return `fa fa-solid fa-${icon} fa-fw`;
                }
                mimeType = mimeType.slice(0, -1);
            }
            return "fa fa-solid fa-file fa-fw";
        },
        [fullConfig.mimetypes]
    );

    const getIconColor = useCallback(
        (mimeType: string): string => fullConfig.mimetypes?.[mimeType]?.color ?? "inherit",
        [fullConfig.mimetypes]
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
                const file = await RpcApi.FileReadCommand(
                    TabRpcClient,
                    {
                        info: {
                            path: await model.formatRemoteUri(dp, globalStore.get),
                        },
                    },
                    null
                );
                const entries = file.entries ?? [];
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
        [model, childrenCache, loadingPaths]
    );

    // Toggle directory expansion
    const toggleExpand = useCallback(
        (path: string, isDir: boolean, isNestParent: boolean) => {
            if (!isDir && !isNestParent) return;

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
        [loadChildren]
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
                // ".." always first
                if (a.name === "..") return -1;
                if (b.name === "..") return 1;
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
                if (fileInfo.name === "..") return true;
                if (!showHiddenFiles && fileInfo.name.startsWith(".")) return false;
                return true;
            });

            const sorted = sortFiles(filtered);
            if (!prefs.fileNesting) {
                return { entries: sorted, nestedMap: new Map() };
            }

            const groups = new Map<string, FileInfo[]>();
            const isNestable = (item: FileInfo) => !item.isdir && item.name && item.name !== "..";
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

                if (prefs.compactFolders && item.isdir && item.name !== "..") {
                    let curPath = item.path;
                    let curName = item.name ?? "";
                    let curChildren = effectiveChildren;
                    while (curChildren && curChildren.length > 0) {
                        const prepared = prepareEntries(curChildren).entries.filter((child) => child.name !== "..");
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

                const effectiveName = item.name === ".." ? ".." : (effectivePath.split("/").pop() ?? item.name);
                const treeItem: TreeFileInfo = {
                    ...item,
                    name: effectiveName,
                    path: effectivePath,
                    depth,
                    displayName: isCompact ? displayName : undefined,
                    isExpanded: isExpanded && hasExpandableChildren,
                    isLoading: loadingPaths.has(effectivePath),
                    isNestParent,
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
            const dotdotIdx = result.findIndex((item) => item.name === "..");
            insertIdx = dotdotIdx >= 0 ? dotdotIdx + 1 : 0;
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
            setFilterText("");
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
        const selectedPath = flatData[focusIndex]?.path ?? null;
        model.directoryKeyDownHandler = (waveEvent: WaveKeyboardEvent): boolean => {
            // Don't handle keys when editing
            if (editingItem != null) return false;
            const activeEl = document.activeElement as HTMLElement | null;
            if (activeEl === searchInputRef.current) {
                return false;
            }

            // Cmd/Ctrl+F - focus search
            if (checkKeyPressed(waveEvent, "Cmd:f") || checkKeyPressed(waveEvent, "Ctrl:f")) {
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
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
                const focusedItem = flatData[focusIndex];
                const targetDir = focusedItem?.isdir && focusedItem.name !== ".." ? focusedItem.path : dirPath;
                if (clipboard) {
                    fireAndForget(() => onPaste(clipboard, targetDir));
                } else {
                    // Try system clipboard files
                    fireAndForget(async () => {
                        const files = await getApi().readClipboardFiles();
                        if (files.length > 0) {
                            for (const srcPath of files) {
                                const name = srcPath.split("/").pop();
                                const desturi = await model.formatRemoteUri(targetDir + "/" + name, globalStore.get);
                                try {
                                    await RpcApi.FileCopyCommand(TabRpcClient, {
                                        srcuri: "wsh://local" + srcPath,
                                        desturi,
                                        opts: { timeout: 31536000000 },
                                    });
                                } catch (e) {
                                    console.warn("Paste from system clipboard failed:", e);
                                }
                            }
                            model.refreshCallback?.();
                            return;
                        }
                        // Try pasting image from clipboard
                        try {
                            const clipboardItems = await navigator.clipboard.read();
                            for (const item of clipboardItems) {
                                if (item.types.includes("image/png")) {
                                    const blob = await item.getType("image/png");
                                    const arrayBuffer = await blob.arrayBuffer();
                                    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                                    const fileName = `image-${Date.now()}.png`;
                                    const filePath = await model.formatRemoteUri(targetDir + "/" + fileName, globalStore.get);
                                    await RpcApi.FileWriteCommand(TabRpcClient, {
                                        info: { path: filePath },
                                        data64: base64,
                                    });
                                    model.refreshCallback?.();
                                    break;
                                }
                            }
                        } catch (e) {
                            // Clipboard API may not be available
                        }
                    });
                }
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
                    if ((item.isdir || item.isNestParent) && expandedPaths.has(item.path)) {
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
                const isExpandable = item && ((item.isdir && item.name !== "..") || item.isNestParent);
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
                            await createBlock({
                                meta: {
                                    view: "preview",
                                    file: item.path,
                                    connection: conn,
                                },
                            });
                        });
                    }
                }
                return true;
            }

            // Space - Quicklook (macOS only, local only)
            if (
                checkKeyPressed(waveEvent, "Space") &&
                PLATFORM === PlatformMacOS &&
                !blockData?.meta?.connection
            ) {
                if (selectedPath) {
                    getApi().onQuicklook(selectedPath);
                }
                return true;
            }

            // Type-to-filter: character keys
            if (isCharacterKeyEvent(waveEvent)) {
                setFilterText((prev) => prev + waveEvent.key);
                if (filterTimeoutRef.current) {
                    clearTimeout(filterTimeoutRef.current);
                }
                filterTimeoutRef.current = setTimeout(() => setFilterText(""), 1500);
                return true;
            }

            // Escape - clear filter
            if (checkKeyPressed(waveEvent, "Escape")) {
                if (searchQuery) {
                    setSearchQuery("");
                    return true;
                }
                if (filterText) {
                    setFilterText("");
                    return true;
                }
                if (selectedPaths.size > 0) {
                    setSelectedPaths(new Set());
                    return true;
                }
                return false;
            }

            // Backspace - remove last filter char
            if (checkKeyPressed(waveEvent, "Backspace")) {
                if (filterText) {
                    setFilterText((prev) => prev.slice(0, -1));
                    if (filterTimeoutRef.current) {
                        clearTimeout(filterTimeoutRef.current);
                    }
                    filterTimeoutRef.current = setTimeout(() => setFilterText(""), 1500);
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
        dirPath, conn, blockData, filterText, searchQuery, model, setFocusIndex, focusAndScroll,
        setSelectedPaths, setClipboard, onPaste, startNewItem, updateName, setErrorMsg, toggleExpand,
        showHiddenFiles, setShowHiddenFiles,
    ]);

    // Type-to-filter: jump to first matching item
    useEffect(() => {
        if (!filterText) return;
        const lowerFilter = filterText.toLowerCase();
        const matchIdx = flatData.findIndex(
            (item) => item.name !== ".." && item.name?.toLowerCase().includes(lowerFilter)
        );
        if (matchIdx >= 0) {
            focusAndScroll(matchIdx);
        }
    }, [filterText, flatData]);

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

    const collapseAll = useCallback(() => {
        setExpandedPaths(new Set());
    }, []);

    const handleViewOptionsMenu = useCallback(
        (e: React.MouseEvent) => {
            const menu: ContextMenuItem[] = [
                {
                    label: "Sort By",
                    submenu: [
                        {
                            label: "Name",
                            type: "radio",
                            checked: prefs.sortMode === "name",
                            click: () => updatePrefs({ sortMode: "name" }),
                        },
                        {
                            label: "Type",
                            type: "radio",
                            checked: prefs.sortMode === "type",
                            click: () => updatePrefs({ sortMode: "type" }),
                        },
                        {
                            label: "Size",
                            type: "radio",
                            checked: prefs.sortMode === "size",
                            click: () => updatePrefs({ sortMode: "size" }),
                        },
                        {
                            label: "Modified",
                            type: "radio",
                            checked: prefs.sortMode === "modified",
                            click: () => updatePrefs({ sortMode: "modified" }),
                        },
                    ],
                },
                {
                    label: "Sort Order",
                    submenu: [
                        {
                            label: "Ascending",
                            type: "radio",
                            checked: prefs.sortDir === "asc",
                            click: () => updatePrefs({ sortDir: "asc" }),
                        },
                        {
                            label: "Descending",
                            type: "radio",
                            checked: prefs.sortDir === "desc",
                            click: () => updatePrefs({ sortDir: "desc" }),
                        },
                    ],
                },
                { type: "separator" },
                {
                    label: "Folders First",
                    type: "checkbox",
                    checked: prefs.foldersFirst,
                    click: () => updatePrefs({ foldersFirst: !prefs.foldersFirst }),
                },
                {
                    label: "Compact Folders",
                    type: "checkbox",
                    checked: prefs.compactFolders,
                    click: () => updatePrefs({ compactFolders: !prefs.compactFolders }),
                },
                {
                    label: "File Nesting",
                    type: "checkbox",
                    checked: prefs.fileNesting,
                    click: () => updatePrefs({ fileNesting: !prefs.fileNesting }),
                },
                {
                    label: "Show Icons",
                    type: "checkbox",
                    checked: prefs.showIcons,
                    click: () => updatePrefs({ showIcons: !prefs.showIcons }),
                },
                {
                    label: "Show Hidden Files",
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
        async (e: any, finfo: FileInfo) => {
            e.preventDefault();
            e.stopPropagation();
            if (finfo == null) return;

            const fileName = finfo.path.split("/").pop();
            const relativePath =
                dirPath && finfo.path.startsWith(dirPath + "/") ? finfo.path.slice(dirPath.length + 1) : null;
            const menu: ContextMenuItem[] = [];

            // Add "Open Folder" and "Add to Bookmarks" options for directories
            if (finfo.isdir && finfo.name !== "..") {
                menu.push({
                    label: "Open Folder",
                    click: () => {
                        model.goHistory(finfo.path);
                    },
                });
                menu.push({
                    label: "Open in Terminal",
                    click: () => {
                        fireAndForget(async () => {
                            await createBlock({
                                meta: {
                                    view: "term",
                                    controller: "shell",
                                    "cmd:cwd": finfo.path,
                                    connection: conn,
                                },
                            });
                        });
                    },
                });
                menu.push({
                    label: "Add to Bookmarks",
                    click: () => {
                        const defaultLabel = finfo.name || finfo.path.split("/").pop() || "Bookmark";
                        setEntryManagerProps({
                            entryManagerType: EntryManagerType.BookmarkLabel,
                            startingValue: defaultLabel,
                            onSave: (bookmarkLabel: string) => {
                                fireAndForget(() => model.addBookmark(finfo.path, bookmarkLabel));
                                setEntryManagerProps(undefined);
                            },
                        });
                    },
                });
                menu.push({ type: "separator" });
            } else if (finfo.isdir && finfo.name === "..") {
                menu.push({
                    label: "Open Folder",
                    click: () => {
                        model.goHistory(finfo.path);
                    },
                });
                menu.push({ type: "separator" });
            } else {
                // File: Open in Terminal uses parent directory
                menu.push({
                    label: "Open in Terminal",
                    click: () => {
                        fireAndForget(async () => {
                            const parentDir = finfo.path.replace(/\/[^/]+$/, "");
                            await createBlock({
                                meta: {
                                    view: "term",
                                    controller: "shell",
                                    "cmd:cwd": parentDir,
                                    connection: conn,
                                },
                            });
                        });
                    },
                });
            }

            // Reveal in Finder (local only)
            if (!conn) {
                menu.push({
                    label: "Reveal in Finder",
                    click: () => getApi().showItemInFolder(finfo.path),
                });
            }

            menu.push({ type: "separator" });
            menu.push(
                { label: "New File", click: () => startNewItem(false) },
                { label: "New Folder", click: () => startNewItem(true) },
                { label: "Rename", click: () => updateName(finfo.path, finfo.isdir) },
                { type: "separator" },
                { label: "Copy", click: () => {
                    const items = getSelectedItems();
                    if (items.length > 0) {
                        setClipboard({
                            paths: items.map((i) => i.path),
                            names: items.map((i) => i.name),
                            isDirs: items.map((i) => i.isdir),
                            operation: "copy",
                        });
                    }
                }},
                { label: "Cut", click: () => {
                    const items = getSelectedItems();
                    if (items.length > 0) {
                        setClipboard({
                            paths: items.map((i) => i.path),
                            names: items.map((i) => i.name),
                            isDirs: items.map((i) => i.isdir),
                            operation: "cut",
                        });
                    }
                }},
            );
            if (clipboard) {
                const targetDir = finfo.isdir && finfo.name !== ".." ? finfo.path : dirPath;
                menu.push({
                    label: `Paste (${clipboard.paths.length} item${clipboard.paths.length > 1 ? "s" : ""})`,
                    click: () => fireAndForget(() => onPaste(clipboard, targetDir)),
                });
            }
            menu.push(
                { type: "separator" },
                { label: "Copy File Name", click: () => fireAndForget(() => navigator.clipboard.writeText(fileName)) },
                { label: "Copy Full File Name", click: () => fireAndForget(() => navigator.clipboard.writeText(finfo.path)) },
                { label: "Copy File Name (Shell Quoted)", click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([fileName]))) },
                { label: "Copy Full File Name (Shell Quoted)", click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([finfo.path]))) },
            );
            if (relativePath) {
                menu.push(
                    { label: "Copy Relative Path", click: () => fireAndForget(() => navigator.clipboard.writeText(relativePath)) },
                    { label: "Copy Relative Path (Shell Quoted)", click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([relativePath]))) },
                );
            }
            addOpenMenuItems(menu, conn, finfo);
            menu.push(
                { type: "separator" },
                { label: "Delete", click: () => {
                    if (selectedPaths.size > 0) {
                        for (const p of selectedPaths) {
                            handleFileDelete(model, p, false, setErrorMsg);
                        }
                        setSelectedPaths(new Set());
                    } else {
                        handleFileDelete(model, finfo.path, false, setErrorMsg);
                    }
                }}
            );
            ContextMenuModel.showContextMenu(menu, e);
        },
        [conn, model, startNewItem, updateName, setErrorMsg, setEntryManagerProps,
         clipboard, selectedPaths, dirPath, onPaste, getSelectedItems, setClipboard, setSelectedPaths]
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

    return (
        <div className="dir-tree">
            <div className="dir-tree-controls">
                <div className="dir-tree-search">
                    <i className="fa fa-search" />
                    <input
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                e.preventDefault();
                                setSearchQuery("");
                                searchInputRef.current?.blur();
                            }
                        }}
                        placeholder="Filter files"
                    />
                    {searchQuery ? (
                        <button
                            className="dir-tree-control-button"
                            onClick={() => setSearchQuery("")}
                            title="Clear search"
                        >
                            <i className="fa fa-times" />
                        </button>
                    ) : null}
                    <button
                        className={clsx("dir-tree-control-toggle", { active: searchMatchCase })}
                        onClick={() => setSearchMatchCase((prev) => !prev)}
                        title="Match case"
                    >
                        Aa
                    </button>
                    <button
                        className={clsx("dir-tree-control-toggle", { active: searchUseRegex })}
                        onClick={() => setSearchUseRegex((prev) => !prev)}
                        title="Use regex"
                    >
                        .*
                    </button>
                </div>
                <div className="dir-tree-actions">
                    <button
                        className="dir-tree-control-button"
                        onClick={() => startNewItem(false)}
                        title="New File"
                    >
                        <i className="fa fa-file" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={() => startNewItem(true)}
                        title="New Folder"
                    >
                        <i className="fa fa-folder" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={() => model.refreshCallback?.()}
                        title="Refresh"
                    >
                        <i className="fa fa-rotate-right" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={collapseAll}
                        title="Collapse all"
                    >
                        <i className="fa fa-compress" />
                    </button>
                    <button
                        className="dir-tree-control-button"
                        onClick={handleViewOptionsMenu}
                        title="View options"
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
                            {searchQuery ? "No matches" : "No files"}
                        </div>
                    )}
                </div>
            </OverlayScrollbarsComponent>
            {filterText && (
                <div className="dir-tree-filter-bar">
                    <span className="dir-tree-filter-text">Filter: </span>
                    <span>{filterText}</span>
                    <span
                        className="dir-tree-filter-close"
                        onClick={() => setFilterText("")}
                    >
                        <i className="fa fa-times" />
                    </span>
                </div>
            )}
        </div>
    );
}

interface TreeRowProps {
    model: PreviewModel;
    item: TreeFileInfo;
    idx: number;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    toggleExpand: (path: string, isDir: boolean, isNestParent: boolean) => void;
    getIconFromMimeType: (mimeType: string) => string;
    getIconColor: (mimeType: string) => string;
    handleFileContextMenu: (e: any, finfo: FileInfo) => Promise<void>;
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
    const dirPath = useAtomValue(model.statFilePath);
    const connection = useAtomValue(model.connection);

    const dragItem: DraggedFile = {
        relName: item.name,
        absParent: dirPath,
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
        if (item.isdir && item.name !== "..") {
            // Double-click on directory: expand/collapse
            toggleExpand(item.path, true, item.isNestParent ?? false);
        } else if (item.isNestParent) {
            toggleExpand(item.path, false, true);
        } else if (item.name === "..") {
            // Double-click on "..": navigate to parent
            model.goHistory(item.path);
        } else {
            // Double-click on file: open in new block
            fireAndForget(async () => {
                const blockDef: BlockDef = {
                    meta: {
                        view: "preview",
                        file: item.path,
                        connection: connection,
                    },
                };
                await createBlock(blockDef);
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

    // Render chevron for directories or nested files
    const renderChevron = () => {
        const isExpandable = (item.isdir && item.name !== "..") || item.isNestParent;
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
            onContextMenu={isEditing ? undefined : (e) => handleFileContextMenu(e, item)}
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
    const showHiddenFiles = useAtomValue(model.showHiddenFiles);
    const [selectedPath, setSelectedPath] = useState("");
    const [refreshVersion, setRefreshVersion] = useAtom(model.refreshVersion);
    const conn = useAtomValue(model.connection);
    const blockData = useAtomValue(model.blockAtom);
    const finfo = useAtomValue(model.statFile);
    const dirPath = finfo?.path;
    const dirPathValue = dirPath ?? "";
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const prefsMeta = (blockData?.meta?.[PreviewPrefsMetaKey] ?? {}) as Partial<PreviewPrefs>;
    const prefsMetaJson = useMemo(() => JSON.stringify(prefsMeta), [prefsMeta]);
    const [prefs, setPrefs] = useState<Required<PreviewPrefs>>(() => ({
        ...DefaultPreviewPrefs,
        ...prefsMeta,
    }));
    const updatePrefs = useCallback((patch: Partial<PreviewPrefs>) => {
        setPrefs((prev) => ({ ...prev, ...patch }));
    }, []);
    const prefsJson = useMemo(() => JSON.stringify(prefs), [prefs]);

    // Multi-select state
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

    // Internal clipboard
    const [clipboard, setClipboard] = useState<FileClipboard | null>(null);

    useEffect(() => {
        model.refreshCallback = () => {
            setRefreshVersion((refreshVersion) => refreshVersion + 1);
        };
        return () => {
            model.refreshCallback = null;
        };
    }, [setRefreshVersion]);

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
            ObjectService.UpdateObjectMeta(WOS.makeORef("block", blockId), {
                [PreviewPrefsMetaKey]: prefs,
            })
        );
    }, [prefsJson, prefsMetaJson, blockData?.oid]);

    // Subscribe to directory watch events for automatic refresh
    useEffect(() => {
        const blockId = blockData?.oid;
        if (!dirPath || !blockId || conn) {
            // Only watch local directories for now
            return;
        }

        // Subscribe to directory watch for top-level dir
        fireAndForget(async () => {
            try {
                await RpcApi.DirWatchSubscribeCommand(TabRpcClient, {
                    dirpath: dirPath,
                    blockid: blockId,
                });
            } catch (e) {
                console.log("Failed to subscribe to directory watch:", e);
            }
        });

        // Listen for directory change events
        const unsub = waveEventSubscribe({
            eventType: "dirwatch",
            scope: `block:${blockId}`,
            handler: () => {
                setRefreshVersion((v) => v + 1);
            },
        });

        return () => {
            unsub();
            // Unsubscribe from directory watch
            fireAndForget(async () => {
                try {
                    await RpcApi.DirWatchUnsubscribeCommand(TabRpcClient, {
                        dirpath: dirPath,
                        blockid: blockId,
                    });
                } catch (e) {
                    // Ignore errors on cleanup
                }
            });
        };
    }, [dirPath, blockData?.oid, conn, setRefreshVersion]);

    useEffect(
        () =>
            fireAndForget(async () => {
                let entries: FileInfo[];
                try {
                    const file = await RpcApi.FileReadCommand(
                        TabRpcClient,
                        {
                            info: {
                                path: await model.formatRemoteUri(dirPath, globalStore.get),
                            },
                        },
                        null
                    );
                    entries = file.entries ?? [];
                    if (file?.info && file.info.dir && file.info?.path !== file.info?.dir) {
                        entries.unshift({
                            name: "..",
                            path: file?.info?.dir,
                            isdir: true,
                            modtime: new Date().getTime(),
                            mimetype: "directory",
                        });
                    }
                } catch (e) {
                    setErrorMsg({
                        status: "Cannot Read Directory",
                        text: `${e}`,
                    });
                }
                setUnfilteredData(entries);
            }),
        [conn, dirPath, refreshVersion]
    );

    const filteredData = useMemo(
        () =>
            unfilteredData?.filter((fileInfo) => {
                if (fileInfo.name == null) {
                    console.log("fileInfo.name is null", fileInfo);
                    return false;
                }
                if (!showHiddenFiles && fileInfo.name.startsWith(".") && fileInfo.name != "..") {
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
                        status: "Confirm Overwrite File(s)",
                        text: "This copy operation will overwrite an existing file. Would you like to continue?",
                        level: "warning",
                        buttons: [
                            {
                                text: "Delete Then Copy",
                                onClick: async () => {
                                    data.opts.overwrite = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                            {
                                text: "Sync",
                                onClick: async () => {
                                    data.opts.merge = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                        ],
                    };
                } else {
                    errorMsg = {
                        status: "Copy Failed",
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
                        status: "Confirm Overwrite",
                        text: "Target already exists. Overwrite it?",
                        level: "warning",
                        buttons: [
                            {
                                text: "Overwrite",
                                onClick: async () => {
                                    data.opts.overwrite = true;
                                    await handleDropMove(data, isDir);
                                },
                            },
                        ],
                    };
                } else {
                    errorMsg = {
                        status: "Move Failed",
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
                opts,
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
                    opts: { timeout: timeoutYear },
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
            const menu: ContextMenuItem[] = [
                {
                    label: "New File",
                    click: () => setNewItemRequest({ isDir: false, parentPath: dirPath }),
                },
                {
                    label: "New Folder",
                    click: () => setNewItemRequest({ isDir: true, parentPath: dirPath }),
                },
                {
                    type: "separator",
                },
            ];
            if (clipboard) {
                menu.push({
                    label: `Paste (${clipboard.paths.length} item${clipboard.paths.length > 1 ? "s" : ""})`,
                    click: () => fireAndForget(() => handlePaste(clipboard, dirPathValue)),
                });
                menu.push({ type: "separator" });
            }
            // Reveal in Finder (local only)
            if (!conn && dirPath) {
                menu.push({
                    label: "Reveal in Finder",
                    click: () => getApi().showItemInFolder(dirPath),
                });
                menu.push({ type: "separator" });
            }
            addOpenMenuItems(menu, conn, finfo);

            ContextMenuModel.showContextMenu(menu, e);
        },
        [clipboard, conn, dirPath, dirPathValue, finfo, handlePaste]
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
                    dirPath={dirPathValue}
                    onExternalFileDrop={onExternalFileDrop}
                    newItemRequest={newItemRequest}
                    onNewItemHandled={clearNewItemRequest}
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
