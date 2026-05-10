// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CenteredDiv } from "@/app/element/quickelems";
import { Markdown } from "@/element/markdown";
import { resolveRemoteFile, resolveRemoteFileInfo, resolveSrcSet } from "@/app/element/markdown-util";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { waveEventSubscribe } from "@/app/store/wps";
import { BlockHeaderSuggestionControl } from "@/app/suggestion/suggestion";
import { createBlockAtRightmost, getApi, globalStore, openLink } from "@/store/global";
import { normalizeDirectoryWatchPath } from "@/util/directorywatchutil";
import { fireAndForget, isBlank, isLocalConnName, jotaiLoadableValue, makeConnRoute } from "@/util/util";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
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
    markdown: MarkdownFilePreview,
    html: HtmlFilePreview,
    csv: CSVViewPreview,
    directory: DirectoryPreview,
};

function canPreview(mimeType: string): boolean {
    if (mimeType == null) {
        return false;
    }
    const normalizedMimeType = mimeType.toLowerCase().split(";")[0].trim();
    return (
        normalizedMimeType.startsWith("text/csv") ||
        normalizedMimeType === "text/html" ||
        normalizedMimeType === "application/xhtml+xml" ||
        normalizedMimeType.includes("markdown") ||
        normalizedMimeType.includes("mdx")
    );
}

function CSVViewPreview({ model, parentRef }: SpecializedViewProps) {
    const fileContent = useAtomValue(model.fileContent);
    const fileName = useAtomValue(model.statFilePath);
    return <CSVView parentRef={parentRef} readonly={true} content={fileContent} filename={fileName} />;
}

function MarkdownFilePreview({ model }: SpecializedViewProps) {
    const fileContent = useAtomValue(model.fileContent);
    const fileInfo = useAtomValue(model.statFile);
    const connName = useAtomValue(model.connectionImmediate);
    const filePath = fileInfo?.path ?? fileInfo?.name ?? "";
    const baseDir = fileInfo?.dir ?? "";

    return (
        <Markdown
            text={fileContent}
            resolveOpts={{ connName, baseDir }}
            className="preview-markdown-shell"
            contentClassName="preview-markdown-document"
            frontmatterMode="card"
            scrollStateKey={filePath}
            initialScrollTop={model.getPreviewScrollTop(filePath)}
            onScrollTopChange={(scrollTop) => model.setPreviewScrollTop(filePath, scrollTop)}
        />
    );
}

const HtmlUrlAttrSelectors = [
    { selector: "img[src], audio[src], video[src], source[src], track[src], embed[src]", attr: "src" },
    { selector: "object[data]", attr: "data" },
    { selector: "link[href]", attr: "href" },
    { selector: "video[poster]", attr: "poster" },
] as const;

function shouldResolveHtmlAssetUrl(value: string | null): value is string {
    const trimmed = value?.trim() ?? "";
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
        return false;
    }
    if (/^(https?:|data:|blob:|mailto:|tel:|javascript:|vbscript:)/i.test(trimmed)) {
        return false;
    }
    return true;
}

function getHtmlHrefScheme(href: string): string | null {
    const match = href.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
    return match?.[1]?.toLowerCase() ?? null;
}

function isBlockedHtmlHref(href: string): boolean {
    return /^(javascript|vbscript|data|blob):/i.test(href.trim());
}

function isExternalHtmlHref(href: string): boolean {
    const trimmed = href.trim();
    if (/^\/\//.test(trimmed)) {
        return true;
    }
    const scheme = getHtmlHrefScheme(trimmed);
    return scheme != null && scheme !== "file" && scheme !== "wsh";
}

function normalizeWshUrlPath(pathname: string): string {
    const decodedPathname = decodeURIComponent(pathname);
    if (decodedPathname.startsWith("//")) {
        return decodedPathname.slice(1);
    }
    if (decodedPathname === "/~" || decodedPathname.startsWith("/~/")) {
        return decodedPathname.slice(1);
    }
    return decodedPathname;
}

function parseHtmlFileHref(href: string): { path: string; connName?: string } {
    let normalized = href.trim();
    const hashIdx = normalized.indexOf("#");
    if (hashIdx > 0) {
        normalized = normalized.slice(0, hashIdx);
    }
    if (/^file:\/\//i.test(normalized)) {
        try {
            return { path: decodeURIComponent(new URL(normalized).pathname) };
        } catch {
            return { path: normalized.replace(/^file:\/\//i, "") };
        }
    }
    if (/^wsh:\/\//i.test(normalized)) {
        try {
            const url = new URL(normalized);
            return {
                path: normalizeWshUrlPath(url.pathname),
                connName: decodeURIComponent(url.hostname || "local"),
            };
        } catch {
            return { path: normalized.replace(/^wsh:\/\/[^/]+\//i, "") };
        }
    }
    return { path: normalized };
}

async function openHtmlFileInCurrentTab(filePath: string, connName?: string | null) {
    const blockDef: BlockDef = {
        meta: {
            view: "preview",
            file: filePath,
            connection: connName,
        },
    };
    await createBlockAtRightmost(blockDef);
}

async function resolveHtmlLinkedFileInfo(hrefPath: string, resolveOpts: MarkdownResolveOpts): Promise<FileInfo | null> {
    const fileInfo = await resolveRemoteFileInfo(hrefPath, resolveOpts);
    if (fileInfo?.path && !fileInfo.notfound) {
        return fileInfo;
    }
    if (hrefPath.startsWith("/") && !hrefPath.startsWith("//")) {
        return await resolveRemoteFileInfo(`.${hrefPath}`, resolveOpts);
    }
    return null;
}

async function openHtmlPreviewHref(href: string, resolveOpts: MarkdownResolveOpts) {
    if (!href || isBlockedHtmlHref(href)) {
        return;
    }
    if (isExternalHtmlHref(href) || resolveOpts == null) {
        await openLink(href);
        return;
    }
    const fileRef = parseHtmlFileHref(href);
    if (!fileRef.path) {
        return;
    }
    if (fileRef.connName != null) {
        await openHtmlFileInCurrentTab(fileRef.path, fileRef.connName);
        return;
    }
    const fileInfo = await resolveHtmlLinkedFileInfo(fileRef.path, resolveOpts);
    if (fileInfo?.path && !fileInfo.notfound) {
        await openHtmlFileInCurrentTab(fileInfo.path, resolveOpts.connName);
        return;
    }
    if (/^https?:/i.test(href)) {
        await openLink(href);
    }
}

async function resolveHtmlPreviewSrcDoc(html: string, resolveOpts: MarkdownResolveOpts): Promise<string> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html ?? "", "text/html");
    const resolveTasks: Promise<void>[] = [];

    for (const { selector, attr } of HtmlUrlAttrSelectors) {
        doc.querySelectorAll(selector).forEach((elem) => {
            const rawValue = elem.getAttribute(attr);
            if (!shouldResolveHtmlAssetUrl(rawValue)) {
                return;
            }
            resolveTasks.push(
                resolveRemoteFile(rawValue, resolveOpts).then((resolved) => {
                    if (resolved) {
                        elem.setAttribute(attr, resolved);
                    }
                })
            );
        });
    }

    doc.querySelectorAll("img[srcset], source[srcset]").forEach((elem) => {
        const rawSrcSet = elem.getAttribute("srcset");
        if (!rawSrcSet || /(^|,\s*)(https?:|data:|\/\/)/i.test(rawSrcSet)) {
            return;
        }
        resolveTasks.push(
            resolveSrcSet(rawSrcSet, resolveOpts).then((resolved) => {
                if (resolved) {
                    elem.setAttribute("srcset", resolved);
                }
            })
        );
    });

    await Promise.all(resolveTasks);
    return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function HtmlFilePreview({ model }: SpecializedViewProps) {
    const fileContent = useAtomValue(model.fileContent);
    const fileInfo = useAtomValue(model.statFile);
    const connName = useAtomValue(model.connectionImmediate);
    const filePath = fileInfo?.path ?? fileInfo?.name ?? "";
    const baseDir = fileInfo?.dir ?? "";
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const frameClickCleanupRef = useRef<(() => void) | null>(null);
    const [srcDoc, setSrcDoc] = useState(fileContent ?? "");

    const handleFrameLoad = useCallback(() => {
        frameClickCleanupRef.current?.();
        frameClickCleanupRef.current = null;
        const doc = iframeRef.current?.contentDocument;
        if (doc == null) {
            return;
        }
        const onClick = (event: MouseEvent) => {
            const target = event.target as Element | null;
            const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
            if (anchor == null) {
                return;
            }
            const href = anchor.getAttribute("href")?.trim() ?? "";
            if (!href) {
                return;
            }
            event.preventDefault();
            if (href.startsWith("#")) {
                let targetId = href.slice(1);
                try {
                    targetId = decodeURIComponent(targetId);
                } catch {
                    // Keep the raw anchor id.
                }
                doc.getElementById(targetId)?.scrollIntoView({ block: "start" });
                return;
            }
            fireAndForget(() => openHtmlPreviewHref(href, { connName, baseDir }));
        };
        doc.addEventListener("click", onClick);
        frameClickCleanupRef.current = () => doc.removeEventListener("click", onClick);
    }, [connName, baseDir]);

    useEffect(() => {
        let disposed = false;
        resolveHtmlPreviewSrcDoc(fileContent ?? "", { connName, baseDir })
            .then((resolved) => {
                if (!disposed) {
                    setSrcDoc(resolved);
                }
            })
            .catch(() => {
                if (!disposed) {
                    setSrcDoc(fileContent ?? "");
                }
            });
        return () => {
            disposed = true;
        };
    }, [fileContent, connName, baseDir]);

    useEffect(() => {
        return () => {
            frameClickCleanupRef.current?.();
            frameClickCleanupRef.current = null;
        };
    }, []);

    return (
        <iframe
            ref={iframeRef}
            className="h-full w-full border-0 bg-white"
            name="htmlview"
            sandbox="allow-same-origin"
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            title={filePath || "HTML Preview"}
            onLoad={handleFrameLoad}
        />
    );
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
