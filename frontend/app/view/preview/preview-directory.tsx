// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, createBlock, getApi, globalStore } from "@/app/store/global";
import { waveEventSubscribe } from "@/app/store/wps";
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

// Extended FileInfo with tree-specific properties
interface TreeFileInfo extends FileInfo {
    depth: number;
    children?: TreeFileInfo[];
    isExpanded?: boolean;
    isLoading?: boolean;
}

interface DirectoryTreeProps {
    model: PreviewModel;
    data: FileInfo[];
    search: string;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSearch: (_: string) => void;
    setSelectedPath: (_: string) => void;
    setRefreshVersion: React.Dispatch<React.SetStateAction<number>>;
    entryManagerOverlayPropsAtom: PrimitiveAtom<EntryManagerOverlayProps>;
    newFile: () => void;
    newDirectory: () => void;
    onFileDrop: (draggedFile: DraggedFile, targetPath: string) => Promise<void>;
}

function DirectoryTree({
    model,
    data,
    search,
    focusIndex,
    setFocusIndex,
    setSearch,
    setSelectedPath,
    setRefreshVersion,
    entryManagerOverlayPropsAtom,
    newFile,
    newDirectory,
    onFileDrop,
}: DirectoryTreeProps) {
    const searchActive = useAtomValue(model.directorySearchActive);
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const conn = useAtomValue(model.connection);
    const osRef = useRef<OverlayScrollbarsComponentRef>(null);
    const bodyRef = useRef<HTMLDivElement>(null);

    // Track expanded directories
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    // Track loaded children for each directory
    const [childrenCache, setChildrenCache] = useState<Map<string, FileInfo[]>>(new Map());
    // Track loading state
    const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

    // Listen to refreshVersion and clear cache when it changes
    const refreshVersion = useAtomValue(model.refreshVersion);
    useEffect(() => {
        // Clear children cache to force reload of expanded directories
        setChildrenCache(new Map());
    }, [refreshVersion]);

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
            const fileName = path.split("/").at(-1);
            setEntryManagerProps({
                entryManagerType: EntryManagerType.EditName,
                startingValue: fileName,
                onSave: (newName: string) => {
                    let newPath: string;
                    if (newName !== fileName) {
                        const lastInstance = path.lastIndexOf(fileName);
                        newPath = path.substring(0, lastInstance) + newName;
                        handleRename(model, path, newPath, isDir, setErrorMsg);
                    }
                    setEntryManagerProps(undefined);
                },
            });
        },
        [model, setErrorMsg]
    );

    // Load children for a directory
    const loadChildren = useCallback(
        async (dirPath: string) => {
            if (childrenCache.has(dirPath) || loadingPaths.has(dirPath)) {
                return;
            }

            setLoadingPaths((prev) => new Set(prev).add(dirPath));

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
                const entries = file.entries ?? [];
                setChildrenCache((prev) => new Map(prev).set(dirPath, entries));
            } catch (e) {
                console.error("Failed to load directory:", e);
            } finally {
                setLoadingPaths((prev) => {
                    const next = new Set(prev);
                    next.delete(dirPath);
                    return next;
                });
            }
        },
        [model, childrenCache, loadingPaths]
    );

    // Toggle directory expansion
    const toggleExpand = useCallback(
        (path: string, isDir: boolean) => {
            if (!isDir) return;

            setExpandedPaths((prev) => {
                const next = new Set(prev);
                if (next.has(path)) {
                    next.delete(path);
                } else {
                    next.add(path);
                    loadChildren(path);
                }
                return next;
            });
        },
        [loadChildren]
    );

    // Sort files: directories first, then alphabetically
    const sortFiles = useCallback((files: FileInfo[]): FileInfo[] => {
        return [...files].sort((a, b) => {
            // ".." always first
            if (a.name === "..") return -1;
            if (b.name === "..") return 1;
            // Directories before files
            if (a.isdir && !b.isdir) return -1;
            if (!a.isdir && b.isdir) return 1;
            // Alphabetical
            return (a.name ?? "").localeCompare(b.name ?? "");
        });
    }, []);

    // Build flat list of visible items for rendering
    const flattenTree = useCallback(
        (items: FileInfo[], depth: number = 0): TreeFileInfo[] => {
            const result: TreeFileInfo[] = [];
            const sorted = sortFiles(items);

            for (const item of sorted) {
                const isExpanded = expandedPaths.has(item.path);
                const children = childrenCache.get(item.path);
                const hasChildren = children && children.length > 0;

                const treeItem: TreeFileInfo = {
                    ...item,
                    depth,
                    // Only show as expanded if we actually have children to display
                    isExpanded: isExpanded && hasChildren,
                    isLoading: loadingPaths.has(item.path),
                };
                result.push(treeItem);

                // Add children if expanded and we have them
                if (item.isdir && isExpanded && hasChildren) {
                    result.push(...flattenTree(children, depth + 1));
                }
            }

            return result;
        },
        [expandedPaths, childrenCache, loadingPaths, sortFiles]
    );

    const flatData = useMemo(() => flattenTree(data), [data, flattenTree]);

    // Update selected path when focus changes
    useEffect(() => {
        setSelectedPath(flatData[focusIndex]?.path ?? null);
    }, [focusIndex, flatData, setSelectedPath]);

    // Scroll focused item into view
    useEffect(() => {
        if (focusIndex === null || !bodyRef.current || !osRef.current) {
            return;
        }

        const rowElement = bodyRef.current.querySelector(`[data-rowindex="${focusIndex}"]`) as HTMLDivElement;
        if (!rowElement) {
            return;
        }

        const viewport = osRef.current.osInstance().elements().viewport;
        const viewportHeight = viewport.offsetHeight;
        const rowRect = rowElement.getBoundingClientRect();
        const parentRect = viewport.getBoundingClientRect();
        const viewportScrollTop = viewport.scrollTop;
        const rowTopRelativeToViewport = rowRect.top - parentRect.top + viewport.scrollTop;
        const rowBottomRelativeToViewport = rowRect.bottom - parentRect.top + viewport.scrollTop;

        if (rowTopRelativeToViewport - 30 < viewportScrollTop) {
            let topVal = rowTopRelativeToViewport - 30;
            if (topVal < 0) topVal = 0;
            viewport.scrollTo({ top: topVal });
        } else if (rowBottomRelativeToViewport + 5 > viewportScrollTop + viewportHeight) {
            const topVal = rowBottomRelativeToViewport - viewportHeight + 5;
            viewport.scrollTo({ top: topVal });
        }
    }, [focusIndex]);

    const handleFileContextMenu = useCallback(
        async (e: any, finfo: FileInfo) => {
            e.preventDefault();
            e.stopPropagation();
            if (finfo == null) return;

            const fileName = finfo.path.split("/").pop();
            const menu: ContextMenuItem[] = [];

            // Add "Open Folder" option for directories
            if (finfo.isdir) {
                menu.push({
                    label: "Open Folder",
                    click: () => {
                        model.goHistory(finfo.path);
                        globalStore.set(model.directorySearchActive, false);
                    },
                });
                menu.push({ type: "separator" });
            }

            menu.push(
                { label: "New File", click: () => newFile() },
                { label: "New Folder", click: () => newDirectory() },
                { label: "Rename", click: () => updateName(finfo.path, finfo.isdir) },
                { type: "separator" },
                { label: "Copy File Name", click: () => fireAndForget(() => navigator.clipboard.writeText(fileName)) },
                { label: "Copy Full File Name", click: () => fireAndForget(() => navigator.clipboard.writeText(finfo.path)) },
                { label: "Copy File Name (Shell Quoted)", click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([fileName]))) },
                { label: "Copy Full File Name (Shell Quoted)", click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([finfo.path]))) },
            );
            addOpenMenuItems(menu, conn, finfo);
            menu.push(
                { type: "separator" },
                { label: "Delete", click: () => handleFileDelete(model, finfo.path, false, setErrorMsg) }
            );
            ContextMenuModel.showContextMenu(menu, e);
        },
        [conn, model, newFile, newDirectory, updateName, setErrorMsg]
    );

    return (
        <OverlayScrollbarsComponent
            options={{ scrollbars: { autoHide: "leave" } }}
            className="dir-tree"
            ref={osRef}
        >
            <div className="dir-tree-body" ref={bodyRef}>
                {(searchActive || search !== "") && (
                    <div className="dir-tree-search-bar">
                        <span>{search === "" ? "Type to search (Esc to cancel)" : `Searching for "${search}"`}</span>
                        <div
                            className="dir-tree-search-close"
                            onClick={() => {
                                setSearch("");
                                globalStore.set(model.directorySearchActive, false);
                            }}
                        >
                            <i className="fa-solid fa-xmark" />
                        </div>
                    </div>
                )}
                {flatData.map((item, idx) => (
                    <TreeRow
                        key={item.path + "-" + idx}
                        model={model}
                        item={item}
                        idx={idx}
                        focusIndex={focusIndex}
                        setFocusIndex={setFocusIndex}
                        setSearch={setSearch}
                        toggleExpand={toggleExpand}
                        getIconFromMimeType={getIconFromMimeType}
                        getIconColor={getIconColor}
                        handleFileContextMenu={handleFileContextMenu}
                        onFileDrop={onFileDrop}
                    />
                ))}
            </div>
        </OverlayScrollbarsComponent>
    );
}

interface TreeRowProps {
    model: PreviewModel;
    item: TreeFileInfo;
    idx: number;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSearch: (_: string) => void;
    toggleExpand: (path: string, isDir: boolean) => void;
    getIconFromMimeType: (mimeType: string) => string;
    getIconColor: (mimeType: string) => string;
    handleFileContextMenu: (e: any, finfo: FileInfo) => Promise<void>;
    onFileDrop: (draggedFile: DraggedFile, targetPath: string) => Promise<void>;
}

function TreeRow({
    model,
    item,
    idx,
    focusIndex,
    setFocusIndex,
    setSearch,
    toggleExpand,
    getIconFromMimeType,
    getIconColor,
    handleFileContextMenu,
    onFileDrop,
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
            canDrag: item.name !== "..",
            item: () => dragItem,
            collect: (monitor) => ({
                isDragging: monitor.isDragging(),
            }),
        }),
        [dragItem, item.name]
    );

    const [{ isOver, canDrop }, drop] = useDrop(
        () => ({
            accept: "FILE_ITEM",
            canDrop: (draggedItem: DraggedFile) => {
                // Can only drop on directories
                if (!item.isdir) return false;
                // Can't drop on ".."
                if (item.name === "..") return false;
                // Can't drop on itself
                if (draggedItem.uri === formatRemoteUri(item.path, connection)) return false;
                // Can't drop into its own parent (already there)
                if (draggedItem.absParent === item.path) return false;
                return true;
            },
            drop: async (draggedFile: DraggedFile) => {
                await onFileDrop(draggedFile, item.path);
            },
            collect: (monitor) => ({
                isOver: monitor.isOver(),
                canDrop: monitor.canDrop(),
            }),
        }),
        [item, connection, onFileDrop]
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
            setFocusIndex(idx);
        },
        [idx, setFocusIndex]
    );

    const handleDoubleClick = useCallback(() => {
        if (item.isdir && item.name !== "..") {
            // Double-click on directory: expand/collapse
            toggleExpand(item.path, true);
        } else if (item.name === "..") {
            // Double-click on "..": navigate to parent
            model.goHistory(item.path);
            setSearch("");
            globalStore.set(model.directorySearchActive, false);
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
    }, [item, model, setSearch, toggleExpand, connection]);

    const handleChevronClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            toggleExpand(item.path, item.isdir);
        },
        [item, toggleExpand]
    );

    // Render chevron for directories
    const renderChevron = () => {
        if (!item.isdir || item.name === "..") {
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

    return (
        <div
            className={clsx("dir-tree-row", {
                focused: focusIndex === idx,
                dragging: isDragging,
                "drop-target": isOver && canDrop,
                "drop-not-allowed": isOver && !canDrop,
            })}
            data-rowindex={idx}
            style={{ paddingLeft: `${8 + item.depth * 16}px` }}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onContextMenu={(e) => handleFileContextMenu(e, item)}
            ref={dragDropRef}
        >
            {renderChevron()}
            {renderIcon()}
            <span className="dir-tree-name">{item.name}</span>
        </div>
    );
}

interface DirectoryPreviewProps {
    model: PreviewModel;
}

function DirectoryPreview({ model }: DirectoryPreviewProps) {
    const [searchText, setSearchText] = useState("");
    const [focusIndex, setFocusIndex] = useState(0);
    const [unfilteredData, setUnfilteredData] = useState<FileInfo[]>([]);
    const showHiddenFiles = useAtomValue(model.showHiddenFiles);
    const [selectedPath, setSelectedPath] = useState("");
    const [refreshVersion, setRefreshVersion] = useAtom(model.refreshVersion);
    const conn = useAtomValue(model.connection);
    const blockData = useAtomValue(model.blockAtom);
    const finfo = useAtomValue(model.statFile);
    const dirPath = finfo?.path;
    const setErrorMsg = useSetAtom(model.errorMsgAtom);

    useEffect(() => {
        model.refreshCallback = () => {
            setRefreshVersion((refreshVersion) => refreshVersion + 1);
        };
        return () => {
            model.refreshCallback = null;
        };
    }, [setRefreshVersion]);

    // Subscribe to directory watch events for automatic refresh
    useEffect(() => {
        const blockId = blockData?.oid;
        if (!dirPath || !blockId || conn) {
            // Only watch local directories for now
            return;
        }

        // Subscribe to directory watch
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
                return fileInfo.name.toLowerCase().includes(searchText);
            }) ?? [],
        [unfilteredData, showHiddenFiles, searchText]
    );

    useEffect(() => {
        model.directoryKeyDownHandler = (waveEvent: WaveKeyboardEvent): boolean => {
            if (checkKeyPressed(waveEvent, "Cmd:f")) {
                globalStore.set(model.directorySearchActive, true);
                return true;
            }
            if (checkKeyPressed(waveEvent, "Escape")) {
                setSearchText("");
                globalStore.set(model.directorySearchActive, false);
                return;
            }
            if (checkKeyPressed(waveEvent, "ArrowUp")) {
                setFocusIndex((idx) => Math.max(idx - 1, 0));
                return true;
            }
            if (checkKeyPressed(waveEvent, "ArrowDown")) {
                setFocusIndex((idx) => Math.min(idx + 1, filteredData.length - 1));
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageUp")) {
                setFocusIndex((idx) => Math.max(idx - PageJumpSize, 0));
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageDown")) {
                setFocusIndex((idx) => Math.min(idx + PageJumpSize, filteredData.length - 1));
                return true;
            }
            if (checkKeyPressed(waveEvent, "Enter")) {
                if (filteredData.length == 0) {
                    return;
                }
                model.goHistory(selectedPath);
                setSearchText("");
                globalStore.set(model.directorySearchActive, false);
                return true;
            }
            if (checkKeyPressed(waveEvent, "Backspace")) {
                if (searchText.length == 0) {
                    return true;
                }
                setSearchText((current) => current.slice(0, -1));
                return true;
            }
            if (
                checkKeyPressed(waveEvent, "Space") &&
                searchText == "" &&
                PLATFORM == PlatformMacOS &&
                !blockData?.meta?.connection
            ) {
                getApi().onQuicklook(selectedPath);
                return true;
            }
            if (isCharacterKeyEvent(waveEvent)) {
                setSearchText((current) => current + waveEvent.key);
                return true;
            }
            return false;
        };
        return () => {
            model.directoryKeyDownHandler = null;
        };
    }, [filteredData, selectedPath, searchText]);

    useEffect(() => {
        if (filteredData.length != 0 && focusIndex > filteredData.length - 1) {
            setFocusIndex(filteredData.length - 1);
        }
    }, [filteredData]);

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

    const [, drop] = useDrop(
        () => ({
            accept: "FILE_ITEM", //a name of file drop type
            canDrop: (_, monitor) => {
                const dragItem = monitor.getItem<DraggedFile>();
                // drop if not current dir is the parent directory of the dragged item
                // requires absolute path
                if (monitor.isOver({ shallow: false }) && dragItem.absParent !== dirPath) {
                    return true;
                }
                return false;
            },
            drop: async (draggedFile: DraggedFile, monitor) => {
                if (!monitor.didDrop()) {
                    const timeoutYear = 31536000000; // one year
                    const opts: FileCopyOpts = {
                        timeout: timeoutYear,
                    };
                    // Target path should be: targetFolder + sourceFileName
                    const fullTargetPath = dirPath + "/" + draggedFile.relName;
                    const desturi = await model.formatRemoteUri(fullTargetPath, globalStore.get);
                    const data: CommandFileCopyData = {
                        srcuri: draggedFile.uri,
                        desturi,
                        opts,
                    };
                    await handleDropMove(data, draggedFile.isDir);
                }
            },
            // TODO: mabe add a hover option?
        }),
        [dirPath, model.formatRemoteUri, handleDropMove]
    );

    useEffect(() => {
        drop(refs.reference);
    }, [refs.reference]);

    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

    const newFile = useCallback(() => {
        setEntryManagerProps({
            entryManagerType: EntryManagerType.NewFile,
            onSave: (newName: string) => {
                console.log(`newFile: ${newName}`);
                fireAndForget(async () => {
                    await RpcApi.FileCreateCommand(
                        TabRpcClient,
                        {
                            info: {
                                path: await model.formatRemoteUri(`${dirPath}/${newName}`, globalStore.get),
                            },
                        },
                        null
                    );
                    model.refreshCallback();
                });
                setEntryManagerProps(undefined);
            },
        });
    }, [dirPath]);
    const newDirectory = useCallback(() => {
        setEntryManagerProps({
            entryManagerType: EntryManagerType.NewDirectory,
            onSave: (newName: string) => {
                console.log(`newDirectory: ${newName}`);
                fireAndForget(async () => {
                    await RpcApi.FileMkdirCommand(TabRpcClient, {
                        info: {
                            path: await model.formatRemoteUri(`${dirPath}/${newName}`, globalStore.get),
                        },
                    });
                    model.refreshCallback();
                });
                setEntryManagerProps(undefined);
            },
        });
    }, [dirPath]);

    const handleFileContextMenu = useCallback(
        (e: any) => {
            e.preventDefault();
            e.stopPropagation();
            const menu: ContextMenuItem[] = [
                {
                    label: "New File",
                    click: () => {
                        newFile();
                    },
                },
                {
                    label: "New Folder",
                    click: () => {
                        newDirectory();
                    },
                },
                {
                    type: "separator",
                },
            ];
            addOpenMenuItems(menu, conn, finfo);

            ContextMenuModel.showContextMenu(menu, e);
        },
        [setRefreshVersion, conn, newFile, newDirectory, dirPath]
    );

    return (
        <Fragment>
            <div
                ref={refs.setReference}
                className="dir-table-container"
                onChangeCapture={(e) => {
                    const event = e as React.ChangeEvent<HTMLInputElement>;
                    if (!entryManagerProps) {
                        setSearchText(event.target.value.toLowerCase());
                    }
                }}
                {...getReferenceProps()}
                onContextMenu={(e) => handleFileContextMenu(e)}
                onClick={() => setEntryManagerProps(undefined)}
            >
                <DirectoryTree
                    model={model}
                    data={filteredData}
                    search={searchText}
                    focusIndex={focusIndex}
                    setFocusIndex={setFocusIndex}
                    setSearch={setSearchText}
                    setSelectedPath={setSelectedPath}
                    setRefreshVersion={setRefreshVersion}
                    entryManagerOverlayPropsAtom={entryManagerPropsAtom}
                    newFile={newFile}
                    newDirectory={newDirectory}
                    onFileDrop={onFileDrop}
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
