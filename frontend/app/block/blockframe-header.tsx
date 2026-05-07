// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    blockViewToIcon,
    blockViewToName,
    getViewIconElem,
    renderHeaderElements,
} from "@/app/block/blockutil";
import { ConnectionButton } from "@/app/block/connectionbutton";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { getConnStatusAtom, recordTEvent, WOS } from "@/app/store/global";
import { modalsModel } from "@/store/modalmodel";
import { uxCloseBlock } from "@/app/store/keymodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { IconButton } from "@/element/iconbutton";
import { NodeModel } from "@/layout/index";
import * as util from "@/util/util";
import { cn } from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";
import { BlockFrameProps } from "./blocktypes";

function getDurableIconProps(jobStatus: BlockJobStatusData, connStatus: ConnStatus) {
    let color = "text-muted";
    let titleText = "持久会话";
    const status = jobStatus?.status;
    if (status === "connected") {
        color = "text-sky-500";
        titleText = "持久会话（已附着）";
    } else if (status === "disconnected") {
        color = "text-sky-300";
        titleText = "持久会话（已分离）";
    } else if (status === "init") {
        color = "text-sky-300";
        titleText = "持久会话（启动中）";
    } else if (status === "done") {
        color = "text-muted";
        const doneReason = jobStatus?.donereason;
        if (doneReason === "terminated") {
            titleText = "持久会话（已结束，已退出）";
        } else if (doneReason === "gone") {
            titleText = "持久会话（已结束，环境已丢失）";
        } else if (doneReason === "startuperror") {
            titleText = "持久会话（已结束，启动失败）";
        } else {
            titleText = "持久会话（已结束）";
        }
    } else if (status == null) {
        if (!connStatus?.connected) {
            color = "text-muted";
            titleText = "持久会话（等待连接）";
        } else {
            color = "text-muted";
            titleText = "无会话";
        }
    }
    return { color, titleText };
}

function handleHeaderContextMenu(
    e: React.MouseEvent<HTMLDivElement>,
    blockId: string,
    viewModel: ViewModel,
    _nodeModel: NodeModel,
    blockData: Block
) {
    e.preventDefault();
    e.stopPropagation();
    let menu: ContextMenuItem[] = [
        {
            label: "重命名区块",
            click: () => {
                const currentName = blockData?.meta?.["frame:title"] || "";
                modalsModel.pushModal("RenameBlockModal", { blockId, currentName });
            },
        },
    ];
    const extraItems = viewModel?.getSettingsMenuItems?.();
    if (extraItems && extraItems.length > 0) menu.push({ type: "separator" }, ...extraItems);
    menu.push(
        { type: "separator" },
        {
            label: "关闭区块",
            click: () => uxCloseBlock(blockId),
        }
    );
    ContextMenuModel.showContextMenu(menu, e);
}

type HeaderTextElemsProps = {
    viewModel: ViewModel;
    blockData: Block;
    preview: boolean;
    error?: Error;
};

const HeaderTextElems = React.memo(({ viewModel, blockData, preview, error }: HeaderTextElemsProps) => {
    let headerTextUnion = util.useAtomValueSafe(viewModel?.viewText);
    headerTextUnion = blockData?.meta?.["frame:text"] ?? headerTextUnion;

    const headerTextElems: React.ReactElement[] = [];
    if (typeof headerTextUnion === "string") {
        if (!util.isBlank(headerTextUnion)) {
            headerTextElems.push(
                <div key="text" className="block-frame-text ellipsis">
                    &lrm;{headerTextUnion}
                </div>
            );
        }
    } else if (Array.isArray(headerTextUnion)) {
        headerTextElems.push(...renderHeaderElements(headerTextUnion, preview));
    }
    if (error != null) {
        const copyHeaderErr = () => {
            navigator.clipboard.writeText(error.message + "\n" + error.stack);
        };
        headerTextElems.push(
            <div className="iconbutton disabled" key="controller-status" onClick={copyHeaderErr}>
                <i
                    className="fa-sharp fa-solid fa-triangle-exclamation"
                    title={"渲染视图头部失败：" + error.message}
                />
            </div>
        );
    }

    return <div className="block-frame-textelems-wrapper">{headerTextElems}</div>;
});
HeaderTextElems.displayName = "HeaderTextElems";

type HeaderEndIconsProps = {
    viewModel: ViewModel;
    nodeModel: NodeModel;
    blockId: string;
    blockData: Block;
};

const HeaderEndIcons = React.memo(({ viewModel, nodeModel, blockId, blockData }: HeaderEndIconsProps) => {
    const endIconButtons = util.useAtomValueSafe(viewModel?.endIconButtons);
    const ephemeral = jotai.useAtomValue(nodeModel.isEphemeral);

    const endIconsElem: React.ReactElement[] = [];

    if (endIconButtons && endIconButtons.length > 0) {
        endIconsElem.push(...endIconButtons.map((button, idx) => <IconButton key={idx} decl={button} />));
    }
    const settingsDecl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "cog",
        title: "设置",
        click: (e) => handleHeaderContextMenu(e, blockId, viewModel, nodeModel, blockData),
    };
    endIconsElem.push(<IconButton key="settings" decl={settingsDecl} className="block-frame-settings" />);
    if (ephemeral) {
        const addToLayoutDecl: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: "circle-plus",
            title: "加入布局",
            click: () => {
                nodeModel.addEphemeralNodeToLayout();
            },
        };
        endIconsElem.push(<IconButton key="add-to-layout" decl={addToLayoutDecl} />);
    } else {
        // No extra block-level action here.
    }

    const closeDecl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "xmark-large",
        title: "关闭",
        click: () => uxCloseBlock(nodeModel.blockId),
    };
    endIconsElem.push(<IconButton key="close" decl={closeDecl} className="block-frame-default-close" />);

    return <div className="block-frame-end-icons">{endIconsElem}</div>;
});
HeaderEndIcons.displayName = "HeaderEndIcons";

const BlockFrame_Header = ({
    nodeModel,
    viewModel,
    preview,
    connBtnRef,
    changeConnModalAtom,
    error,
}: BlockFrameProps & { changeConnModalAtom: jotai.PrimitiveAtom<boolean>; error?: Error }) => {
    const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", nodeModel.blockId));
    let viewName = util.useAtomValueSafe(viewModel?.viewName) ?? blockViewToName(blockData?.meta?.view);
    let viewIconUnion = util.useAtomValueSafe(viewModel?.viewIcon) ?? blockViewToIcon(blockData?.meta?.view);
    const preIconButton = util.useAtomValueSafe(viewModel?.preIconButton);
    const useTermHeader = util.useAtomValueSafe(viewModel?.useTermHeader);
    const termDurableStatus = util.useAtomValueSafe(viewModel?.termDurableStatus);
    const hideViewName = util.useAtomValueSafe(viewModel?.hideViewName);
    const magnified = jotai.useAtomValue(nodeModel.isMagnified);
    const prevMagifiedState = React.useRef(magnified);
    const manageConnection = util.useAtomValueSafe(viewModel?.manageConnection);
    const dragHandleRef = preview ? null : nodeModel.dragHandleRef;
    const isTerminalBlock = blockData?.meta?.view === "term";
    viewName = blockData?.meta?.["frame:title"] ?? viewName;
    viewIconUnion = blockData?.meta?.["frame:icon"] ?? viewIconUnion;
    const connName = blockData?.meta?.connection;
    const connStatus = jotai.useAtomValue(getConnStatusAtom(connName));

    React.useEffect(() => {
        if (magnified && !preview && !prevMagifiedState.current) {
            RpcApi.ActivityCommand(TabRpcClient, { nummagnify: 1 });
            recordTEvent("action:magnify", { "block:view": viewName });
        }
        prevMagifiedState.current = magnified;
    }, [magnified]);

    const viewIconElem = getViewIconElem(viewIconUnion, blockData);

    const { color: durableIconColor, titleText: durableTitle } = getDurableIconProps(termDurableStatus, connStatus);

    return (
        <div
            className={cn("block-frame-default-header", useTermHeader && "!pl-[2px]")}
            data-role="block-header"
            ref={dragHandleRef}
            onContextMenu={(e) => handleHeaderContextMenu(e, nodeModel.blockId, viewModel, nodeModel, blockData)}
        >
            {!useTermHeader && (
                <>
                    {preIconButton && <IconButton decl={preIconButton} className="block-frame-preicon-button" />}
                    <div className="block-frame-default-header-iconview">
                        {viewIconElem}
                        {viewName && !hideViewName && <div className="block-frame-view-type">{viewName}</div>}
                    </div>
                </>
            )}
            {manageConnection && (
                <ConnectionButton
                    ref={connBtnRef}
                    key="connbutton"
                    connection={blockData?.meta?.connection}
                    changeConnModalAtom={changeConnModalAtom}
                    isTerminalBlock={isTerminalBlock}
                />
            )}
            {useTermHeader && termDurableStatus != null && (
                <div className="iconbutton disabled text-[13px] ml-[-4px]" key="durable-status">
                    <i className={`fa-sharp fa-solid fa-shield ${durableIconColor}`} title={durableTitle} />
                </div>
            )}
            <HeaderTextElems viewModel={viewModel} blockData={blockData} preview={preview} error={error} />
            <HeaderEndIcons viewModel={viewModel} nodeModel={nodeModel} blockId={nodeModel.blockId} blockData={blockData} />
        </div>
    );
};

export { BlockFrame_Header };
