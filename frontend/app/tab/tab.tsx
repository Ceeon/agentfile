// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    atoms,
    clearAllTabIndicators,
    clearTabIndicatorFromFocus,
    getTabIndicatorAtom,
    globalStore,
    recordTEvent,
    refocusNode,
    setTabIndicator,
} from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { Button } from "@/element/button";
import { ContextMenuModel } from "@/store/contextmenu";
import { fireAndForget, makeIconClass } from "@/util/util";
import clsx from "clsx";
import { useAtomValue } from "jotai";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ObjectService } from "../store/services";
import { makeORef, useWaveObjectValue } from "../store/wos";
import "./tab.scss";

const RenameCurrentTabEvent = "wave:rename-current-tab";

interface TabProps {
    id: string;
    active: boolean;
    isFirst: boolean;
    isBeforeActive: boolean;
    isDragging: boolean;
    tabWidth: number;
    isNew: boolean;
    onSelect: () => void;
    onClose: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null) => void;
    onDragStart: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
    onLoaded: () => void;
}

const Tab = memo(
    forwardRef<HTMLDivElement, TabProps>(
        (
            { id, active, isBeforeActive, isDragging, tabWidth, isNew, onLoaded, onSelect, onClose, onDragStart },
            ref
        ) => {
            const [tabData, _] = useWaveObjectValue<Tab>(makeORef("tab", id));
            const [originalName, setOriginalName] = useState("");
            const [isEditable, setIsEditable] = useState(false);
            const indicator = useAtomValue(getTabIndicatorAtom(id));

            const editableRef = useRef<HTMLDivElement>(null);
            const editableTimeoutRef = useRef<NodeJS.Timeout>(null);
            const loadedRef = useRef(false);
            const tabRef = useRef<HTMLDivElement>(null);

            useImperativeHandle(ref, () => tabRef.current as HTMLDivElement);

            useEffect(() => {
                if (tabData?.name) {
                    setOriginalName(tabData.name);
                }
            }, [tabData]);

            useEffect(() => {
                return () => {
                    if (editableTimeoutRef.current) {
                        clearTimeout(editableTimeoutRef.current);
                    }
                };
            }, []);

            const selectEditableText = useCallback(() => {
                if (!editableRef.current) {
                    return;
                }
                editableRef.current.focus();
                const range = document.createRange();
                const selection = window.getSelection();
                range.selectNodeContents(editableRef.current);
                selection.removeAllRanges();
                selection.addRange(range);
            }, []);

            const startRenameTab = useCallback(() => {
                setIsEditable(true);
                editableTimeoutRef.current = setTimeout(() => {
                    selectEditableText();
                }, 50);
            }, [selectEditableText]);

            const handleRenameTab: React.MouseEventHandler<HTMLDivElement> = (event) => {
                event?.stopPropagation();
                startRenameTab();
            };

            const handleBlur = () => {
                if (!editableRef.current) {
                    setIsEditable(false);
                    return;
                }
                let newText = editableRef.current.innerText.trim();
                newText = newText || originalName;
                editableRef.current.innerText = newText;
                setIsEditable(false);
                fireAndForget(() => ObjectService.UpdateTabName(id, newText));
                setTimeout(() => refocusNode(null), 10);
            };

            const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "a") {
                    event.preventDefault();
                    selectEditableText();
                    return;
                }
                // this counts glyphs, not characters
                const curLen = Array.from(editableRef.current.innerText).length;
                if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (editableRef.current.innerText.trim() === "") {
                        editableRef.current.innerText = originalName;
                    }
                    editableRef.current.blur();
                } else if (event.key === "Escape") {
                    editableRef.current.innerText = originalName;
                    editableRef.current.blur();
                    event.preventDefault();
                    event.stopPropagation();
                } else if (curLen >= 14 && !["Backspace", "Delete", "ArrowLeft", "ArrowRight"].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            };

            useEffect(() => {
                if (!loadedRef.current) {
                    onLoaded();
                    loadedRef.current = true;
                }
            }, [onLoaded]);

            useEffect(() => {
                if (tabRef.current && isNew) {
                    const initialWidth = `${(tabWidth / 3) * 2}px`;
                    tabRef.current.style.setProperty("--initial-tab-width", initialWidth);
                    tabRef.current.style.setProperty("--final-tab-width", `${tabWidth}px`);
                }
            }, [isNew, tabWidth]);

            useEffect(() => {
                const handleRenameRequest = (event: Event) => {
                    const customEvent = event as CustomEvent<{ tabId?: string }>;
                    if (customEvent.detail?.tabId !== id) {
                        return;
                    }
                    startRenameTab();
                };
                window.addEventListener(RenameCurrentTabEvent, handleRenameRequest);
                return () => {
                    window.removeEventListener(RenameCurrentTabEvent, handleRenameRequest);
                };
            }, [id, startRenameTab]);

            // Prevent drag from being triggered on mousedown
            const handleMouseDownOnClose = (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
                event.stopPropagation();
            };

            const handleTabClick = () => {
                const currentIndicator = globalStore.get(getTabIndicatorAtom(id));
                if (currentIndicator?.clearonfocus) {
                    clearTabIndicatorFromFocus(id);
                }
                onSelect();
            };

            const handleContextMenu = useCallback(
                (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
                    e.preventDefault();
                    let menu: ContextMenuItem[] = [];
                    const currentIndicator = globalStore.get(getTabIndicatorAtom(id));
                    if (currentIndicator) {
                        menu.push(
                            {
                                label: "清除标签提示",
                                click: () => setTabIndicator(id, null),
                            },
                            {
                                label: "清除全部提示",
                                click: () => clearAllTabIndicators(),
                            },
                            { type: "separator" }
                        );
                    }
                    menu.push(
                        { label: "重命名标签页", click: () => handleRenameTab(null) },
                        {
                            label: "复制标签页 ID",
                            click: () => fireAndForget(() => navigator.clipboard.writeText(id)),
                        },
                        { type: "separator" }
                    );
                    const fullConfig = globalStore.get(atoms.fullConfigAtom);
                    const bgPresets: string[] = [];
                    for (const key in fullConfig?.presets ?? {}) {
                        if (key.startsWith("bg@")) {
                            bgPresets.push(key);
                        }
                    }
                    bgPresets.sort((a, b) => {
                        const aOrder = fullConfig.presets[a]["display:order"] ?? 0;
                        const bOrder = fullConfig.presets[b]["display:order"] ?? 0;
                        return aOrder - bOrder;
                    });
                    if (bgPresets.length > 0) {
                        const submenu: ContextMenuItem[] = [];
                        const oref = makeORef("tab", id);
                        for (const presetName of bgPresets) {
                            const preset = fullConfig.presets[presetName];
                            if (preset == null) {
                                continue;
                            }
                            submenu.push({
                                label: preset["display:name"] ?? presetName,
                                click: () =>
                                    fireAndForget(async () => {
                                        await ObjectService.UpdateObjectMeta(oref, preset);
                                        RpcApi.ActivityCommand(TabRpcClient, { settabtheme: 1 }, { noresponse: true });
                                        recordTEvent("action:settabtheme");
                                    }),
                            });
                        }
                        menu.push({ label: "背景", type: "submenu", submenu }, { type: "separator" });
                    }
                    menu.push({ label: "关闭标签页", click: () => onClose(null) });
                    ContextMenuModel.showContextMenu(menu, e);
                },
                [handleRenameTab, id, onClose]
            );

            return (
                <div
                    ref={tabRef}
                    className={clsx("tab", {
                        active,
                        dragging: isDragging,
                        "before-active": isBeforeActive,
                        "new-tab": isNew,
                    })}
                    onMouseDown={onDragStart}
                    onClick={handleTabClick}
                    onContextMenu={handleContextMenu}
                    data-tab-id={id}
                >
                    <div className="tab-inner">
                        <div
                            ref={editableRef}
                            className={clsx("name", { focused: isEditable })}
                            contentEditable={isEditable}
                            onDoubleClick={handleRenameTab}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            suppressContentEditableWarning={true}
                        >
                            {tabData?.name}
                        </div>
                        {indicator && (
                            <div
                                className="tab-indicator pointer-events-none"
                                style={{ color: indicator.color || "#fbbf24" }}
                                title="活动提醒"
                            >
                                <i className={makeIconClass(indicator.icon, true, { defaultIcon: "bell" })} />
                            </div>
                        )}
                        <Button
                            className="ghost grey close"
                            onClick={onClose}
                            onMouseDown={handleMouseDownOnClose}
                            title="关闭标签页"
                        >
                            <i className="fa fa-solid fa-xmark" />
                        </Button>
                    </div>
                </div>
            );
        }
    )
);

export { Tab };
