// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CenteredDiv } from "@/app/element/quickelems";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { waveEventSubscribe } from "@/app/store/wps";
import { BlockHeaderSuggestionControl } from "@/app/suggestion/suggestion";
import { getApi, globalStore } from "@/store/global";
import { normalizeDirectoryWatchPath } from "@/util/directorywatchutil";
import { fireAndForget, isBlank, isLocalConnName, jotaiLoadableValue, makeConnRoute } from "@/util/util";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { memo, useEffect, useRef, useState } from "react";
import { CSVView } from "./csvview";
import { DirectoryPreview } from "./preview-directory";
import { CodeEditPreview } from "./preview-edit";
import { ErrorOverlay } from "./preview-error-overlay";
import { type PreviewModel } from "./preview-model";
import { StreamingPreview } from "./preview-streaming";

export type SpecializedViewProps = {
    model: PreviewModel;
    parentRef: React.RefObject<HTMLDivElement>;
};

const FileRefreshFallbackIntervalMs = 1500;

const SpecializedViewMap: { [view: string]: ({ model }: SpecializedViewProps) => React.JSX.Element } = {
    streaming: StreamingPreview,
    codeedit: CodeEditPreview,
    csv: CSVViewPreview,
    directory: DirectoryPreview,
};

function canPreview(mimeType: string): boolean {
    if (mimeType == null) {
        return false;
    }
    const normalizedMimeType = mimeType.toLowerCase();
    return normalizedMimeType.startsWith("text/csv");
}

function CSVViewPreview({ model, parentRef }: SpecializedViewProps) {
    const fileContent = useAtomValue(model.fileContent);
    const fileName = useAtomValue(model.statFilePath);
    return <CSVView parentRef={parentRef} readonly={true} content={fileContent} filename={fileName} />;
}

function getFileRefreshSignature(fileInfo: FileInfo | null | undefined): string {
    if (!fileInfo) {
        return "";
    }
    return JSON.stringify({
        path: fileInfo.path ?? "",
        size: fileInfo.size ?? null,
        modtime: fileInfo.modtime ?? null,
        notfound: fileInfo.notfound ?? false,
    });
}

const SpecializedView = memo(({ parentRef, model }: SpecializedViewProps) => {
    const loadableSpecializedView = useAtomValue(model.loadableSpecializedView);
    const loadableMimeType = useAtomValue(model.fileMimeTypeLoadable);
    const loadableFileInfo = useAtomValue(model.loadableFileInfo);
    const connName = useAtomValue(model.connectionImmediate);
    const setCanPreview = useSetAtom(model.canPreview);
    const homeDir = getApi().getHomeDir();
    const lastFileSignatureRef = useRef("");
    const fileCheckInFlightRef = useRef(false);
    const [stableSpecializedView, setStableSpecializedView] = useState<{ specializedView?: string; errorStr?: string } | null>(
        null
    );
    const [stableMimeType, setStableMimeType] = useState<string | null>(null);
    const [stableFileInfo, setStableFileInfo] = useState<FileInfo | null>(null);

    useEffect(() => {
        if (loadableSpecializedView.state === "hasData") {
            setStableSpecializedView(loadableSpecializedView.data);
        }
    }, [loadableSpecializedView]);

    useEffect(() => {
        if (loadableMimeType.state === "hasData") {
            setStableMimeType(loadableMimeType.data);
        }
    }, [loadableMimeType]);

    useEffect(() => {
        if (loadableFileInfo.state === "hasData") {
            setStableFileInfo(loadableFileInfo.data);
        }
    }, [loadableFileInfo]);

    const specializedView =
        loadableSpecializedView.state === "hasData" ? loadableSpecializedView.data : stableSpecializedView;
    const mimeType = loadableMimeType.state === "hasData" ? loadableMimeType.data : stableMimeType;
    const fileInfo = loadableFileInfo.state === "hasData" ? loadableFileInfo.data : stableFileInfo;
    const path = fileInfo?.path ?? "";

    useEffect(() => {
        setCanPreview(canPreview(mimeType));
    }, [mimeType, setCanPreview]);

    useEffect(() => {
        lastFileSignatureRef.current = getFileRefreshSignature(fileInfo);
    }, [fileInfo]);

    useEffect(() => {
        if (!fileInfo || fileInfo.mimetype === "directory") {
            return;
        }

        const isLocalConnection = isLocalConnName(connName);
        const dirWatchRpcOpts = isLocalConnection ? undefined : { route: makeConnRoute(connName) };
        const checkForExternalFileChange = () => {
            if (globalStore.get(model.newFileContent) != null) {
                return;
            }
            if (fileCheckInFlightRef.current) {
                return;
            }
            fileCheckInFlightRef.current = true;
            fireAndForget(async () => {
                try {
                    const latestInfo = await RpcApi.FileInfoCommand(TabRpcClient, {
                        info: {
                            path: await model.formatRemoteUri(fileInfo.path, globalStore.get),
                        },
                    });
                    const latestSignature = getFileRefreshSignature(latestInfo);
                    if (latestSignature !== lastFileSignatureRef.current) {
                        lastFileSignatureRef.current = latestSignature;
                        if (model.shouldIgnoreOwnFileRefresh(fileInfo.path)) {
                            return;
                        }
                        model.triggerRefresh();
                    }
                } finally {
                    fileCheckInFlightRef.current = false;
                }
            });
        };
        const intervalId = isLocalConnection
            ? null
            : window.setInterval(() => {
                  checkForExternalFileChange();
              }, FileRefreshFallbackIntervalMs);

        fireAndForget(async () => {
            try {
                await RpcApi.DirWatchSubscribeCommand(TabRpcClient, {
                    dirpath: fileInfo.dir,
                    blockid: model.blockId,
                }, dirWatchRpcOpts);
            } catch (e) {
                console.log("Failed to subscribe to file auto refresh:", e);
            }
        });

        const unsub = waveEventSubscribe({
            eventType: "dirwatch",
            scope: `block:${model.blockId}`,
            handler: (event) => {
                const data = event.data as { dirpath?: string; name?: string } | null;
                const eventDirPath = normalizeDirectoryWatchPath(data?.dirpath, homeDir);
                const fileDirPath = normalizeDirectoryWatchPath(fileInfo.dir, homeDir);
                if (eventDirPath !== fileDirPath) {
                    return;
                }
                if (model.shouldIgnoreOwnFileWatchEvent(data?.dirpath, data?.name)) {
                    return;
                }
                checkForExternalFileChange();
            },
        });

        return () => {
            if (intervalId != null) {
                window.clearInterval(intervalId);
            }
            unsub();
            fireAndForget(async () => {
                try {
                    await RpcApi.DirWatchUnsubscribeCommand(TabRpcClient, {
                        dirpath: fileInfo.dir,
                        blockid: model.blockId,
                    }, dirWatchRpcOpts);
                } catch (e) {
                    // ignore cleanup errors
                }
            });
        };
    }, [connName, fileInfo?.dir, fileInfo?.mimetype, fileInfo?.name, homeDir, model]);

    if (!specializedView) {
        return <CenteredDiv>加载中...</CenteredDiv>;
    }
    if (specializedView.errorStr != null) {
        return <CenteredDiv>{specializedView.errorStr}</CenteredDiv>;
    }
    const SpecializedViewComponent = SpecializedViewMap[specializedView.specializedView];
    if (!SpecializedViewComponent) {
        return <CenteredDiv>Invalid Specialized View Component ({specializedView.specializedView})</CenteredDiv>;
    }
    const componentKey = specializedView.specializedView === "directory" ? specializedView.specializedView : path;
    return <SpecializedViewComponent key={componentKey} model={model} parentRef={parentRef} />;
});

const fetchSuggestions = async (
    model: PreviewModel,
    query: string,
    reqContext: SuggestionRequestContext
): Promise<FetchSuggestionsResponse> => {
    const conn = await globalStore.get(model.connection);
    let route = makeConnRoute(conn);
    if (isBlank(conn)) {
        route = null;
    }
    if (reqContext?.dispose) {
        RpcApi.DisposeSuggestionsCommand(TabRpcClient, reqContext.widgetid, { noresponse: true, route: route });
        return null;
    }
    const fileInfo = await globalStore.get(model.statFile);
    if (fileInfo == null) {
        return null;
    }
    const sdata = {
        suggestiontype: "file",
        "file:cwd": fileInfo.path,
        query: query,
        widgetid: reqContext.widgetid,
        reqnum: reqContext.reqnum,
        "file:connection": conn,
    };
    return await RpcApi.FetchSuggestionsCommand(TabRpcClient, sdata, {
        route: route,
    });
};

function PreviewView({
    blockRef,
    contentRef,
    model,
}: {
    blockId: string;
    blockRef: React.RefObject<HTMLDivElement>;
    contentRef: React.RefObject<HTMLDivElement>;
    model: PreviewModel;
}) {
    const connStatus = useAtomValue(model.connStatus);
    const [errorMsg, setErrorMsg] = useAtom(model.errorMsgAtom);
    const connection = useAtomValue(model.connectionImmediate);
    const fileInfo = jotaiLoadableValue(useAtomValue(model.loadableFileInfo), null);

    useEffect(() => {
        console.log("fileInfo or connection changed", fileInfo, connection);
        if (!fileInfo) {
            return;
        }
        setErrorMsg(null);
    }, [connection, fileInfo]);

    if (connStatus?.status != "connected") {
        return null;
    }
    const handleSelect = (s: SuggestionType, queryStr: string): boolean => {
        if (s == null) {
            if (isBlank(queryStr)) {
                globalStore.set(model.openFileModal, false);
                return true;
            }
            model.handleOpenFile(queryStr);
            return true;
        }
        model.handleOpenFile(s["file:path"]);
        return true;
    };
    const handleTab = (s: SuggestionType, query: string): string => {
        if (s["file:mimetype"] == "directory") {
            return s["file:name"] + "/";
        } else {
            return s["file:name"];
        }
    };
    const fetchSuggestionsFn = async (query, ctx) => {
        return await fetchSuggestions(model, query, ctx);
    };

    return (
        <>
            <div key="fullpreview" className="flex flex-col w-full overflow-hidden scrollbar-hide-until-hover">
                {errorMsg && <ErrorOverlay errorMsg={errorMsg} resetOverlay={() => setErrorMsg(null)} />}
                <div ref={contentRef} className="flex-grow overflow-hidden">
                    <SpecializedView parentRef={contentRef} model={model} />
                </div>
            </div>
            <BlockHeaderSuggestionControl
                blockRef={blockRef}
                openAtom={model.openFileModal}
                onClose={() => model.updateOpenFileModalAndError(false)}
                onSelect={handleSelect}
                onTab={handleTab}
                fetchSuggestions={fetchSuggestionsFn}
                placeholderText="打开文件..."
            />
        </>
    );
}

export { PreviewView };
