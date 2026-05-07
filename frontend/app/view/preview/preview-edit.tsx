// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { tryReinjectKey } from "@/app/store/keymodel";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { getApi, globalStore, pushNotification } from "@/store/global";
import { extractAllClipboardData, MIME_TO_EXT } from "@/util/clipboardutil";
import { adaptFromReactOrNativeKeyEvent, checkKeyPressed } from "@/util/keyutil";
import { fireAndForget } from "@/util/util";
import base64 from "base64-js";
import { useAtomValue, useSetAtom } from "jotai";
import * as monaco from "monaco-editor";
import type * as MonacoTypes from "monaco-editor";
import { useEffect, useRef } from "react";
import { getPreviewModelEditorViewState, setPreviewModelEditorViewState } from "./preview-model";
import type { SpecializedViewProps } from "./preview";

export const shellFileMap: Record<string, string> = {
    ".bashrc": "shell",
    ".bash_profile": "shell",
    ".bash_login": "shell",
    ".bash_logout": "shell",
    ".profile": "shell",
    ".zshrc": "shell",
    ".zprofile": "shell",
    ".zshenv": "shell",
    ".zlogin": "shell",
    ".zlogout": "shell",
    ".kshrc": "shell",
    ".cshrc": "shell",
    ".tcshrc": "shell",
    ".xonshrc": "python",
    ".shrc": "shell",
    ".aliases": "shell",
    ".functions": "shell",
    ".exports": "shell",
    ".direnvrc": "shell",
    ".vimrc": "shell",
    ".gvimrc": "shell",
};

const AutoSaveDelayMs = 150;

function joinPath(baseDir: string, childPath: string): string {
    const normalizedBase = baseDir === "/" ? "/" : baseDir.replace(/\/+$/, "");
    const normalizedChild = childPath.replace(/^\/+/, "");
    if (!normalizedBase || normalizedBase === ".") {
        return normalizedChild;
    }
    if (normalizedBase === "/") {
        return `/${normalizedChild}`;
    }
    return `${normalizedBase}/${normalizedChild}`;
}

function makePastedImageName(blob: Blob, index: number): string {
    const ext = MIME_TO_EXT[blob.type] ?? "png";
    const isoStamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `pasted-image-${isoStamp}-${index + 1}.${ext}`;
}

function makeMarkdownImageReference(fileName: string): string {
    return `![](./img/${encodeURIComponent(fileName)})`;
}

function buildImageInsertionText(
    editor: MonacoTypes.editor.IStandaloneCodeEditor,
    references: string[]
): string {
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model) {
        return references.join("\n");
    }
    if (!selection.isEmpty()) {
        return references.join("\n");
    }
    const lineContent = model.getLineContent(selection.startLineNumber);
    const beforeText = lineContent.slice(0, Math.max(0, selection.startColumn - 1));
    const afterText = lineContent.slice(Math.max(0, selection.startColumn - 1));
    const needsLeadingNewline = beforeText.trim().length > 0;
    const needsTrailingNewline = afterText.trim().length > 0;
    return `${needsLeadingNewline ? "\n" : ""}${references.join("\n")}${needsTrailingNewline ? "\n" : ""}`;
}

function clipboardEventHasImage(event: ClipboardEvent): boolean {
    const items = Array.from(event.clipboardData?.items ?? []);
    return items.some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

function isMarkdownEditableFile(fileInfo: FileInfo): boolean {
    if (!fileInfo) {
        return false;
    }
    const normalizedMimeType = fileInfo.mimetype?.toLowerCase() ?? "";
    if (normalizedMimeType.includes("markdown") || normalizedMimeType.includes("mdx")) {
        return true;
    }
    const normalizedPath = (fileInfo.path ?? fileInfo.name ?? "").toLowerCase();
    return (
        normalizedPath.endsWith(".md") ||
        normalizedPath.endsWith(".markdown") ||
        normalizedPath.endsWith(".mdx") ||
        normalizedPath.endsWith(".mdown") ||
        normalizedPath.endsWith(".mkd") ||
        normalizedPath.endsWith(".mdtxt")
    );
}

function createCodeEditKeyDownHandler(model: SpecializedViewProps["model"]) {
    return (e: WaveKeyboardEvent): boolean => {
        if (checkKeyPressed(e, "Cmd:e")) {
            fireAndForget(() => model.setEditMode(false));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:s") || checkKeyPressed(e, "Ctrl:s")) {
            fireAndForget(model.handleFileSave.bind(model));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:Shift:r")) {
            fireAndForget(model.handleFileRevert.bind(model));
            return true;
        }
        return false;
    };
}

function CodeEditPane({ model }: { model: SpecializedViewProps["model"] }) {
    const fileContent = useAtomValue(model.fileContent);
    const newFileContent = useAtomValue(model.newFileContent);
    const setNewFileContent = useSetAtom(model.newFileContent);
    const fileInfo = useAtomValue(model.statFile);
    const fileName = fileInfo?.path || fileInfo?.name;
    const autosaveTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
    const isMarkdownFile = isMarkdownEditableFile(fileInfo);

    const baseName = fileName ? fileName.split("/").pop() : null;
    const language = baseName && shellFileMap[baseName] ? shellFileMap[baseName] : undefined;

    useEffect(() => {
        if (autosaveTimerRef.current != null) {
            clearTimeout(autosaveTimerRef.current);
            autosaveTimerRef.current = null;
        }
        if (fileInfo?.readonly || fileInfo?.notfound || newFileContent == null) {
            return;
        }
        autosaveTimerRef.current = setTimeout(() => {
            autosaveTimerRef.current = null;
            fireAndForget(() => model.handleFileSave(newFileContent));
        }, AutoSaveDelayMs);
        return () => {
            if (autosaveTimerRef.current != null) {
                clearTimeout(autosaveTimerRef.current);
                autosaveTimerRef.current = null;
            }
        };
    }, [fileInfo?.notfound, fileInfo?.readonly, model, newFileContent]);

    function onMount(editor: MonacoTypes.editor.IStandaloneCodeEditor, monacoApi: typeof monaco): () => void {
        model.monacoRef.current = editor;
        const savedViewState = getPreviewModelEditorViewState(model, fileName);
        if (savedViewState != null) {
            editor.restoreViewState(savedViewState);
        }

        const keyDownDisposer = editor.onKeyDown((e: MonacoTypes.IKeyboardEvent) => {
            const waveEvent = adaptFromReactOrNativeKeyEvent(e.browserEvent);
            const handled = tryReinjectKey(waveEvent);
            if (handled) {
                e.stopPropagation();
                e.preventDefault();
            }
        });
        const blurDisposer = editor.onDidBlurEditorText(() => {
            fireAndForget(() => model.handleFileSave());
        });
        const handleWindowPasteCapture = (event: ClipboardEvent) => {
            if (!editor.hasTextFocus()) {
                return;
            }
            if (!isMarkdownFile || fileInfo?.readonly || !fileInfo?.dir) {
                return;
            }
            if (!clipboardEventHasImage(event)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            fireAndForget(async () => {
                try {
                    const clipboardItems = await extractAllClipboardData(event);
                    const eventImages = clipboardItems.flatMap((item) => (item.image ? [item.image] : []));
                    const systemImage = eventImages.length === 0 ? await getApi().readClipboardImage() : null;
                    const images =
                        eventImages.length > 0
                            ? eventImages.map((image) => ({
                                  blob: image,
                                  data64: null,
                                  mimeType: image.type || "image/png",
                              }))
                            : systemImage != null
                              ? [
                                    {
                                        blob: null,
                                        data64: systemImage.data64,
                                        mimeType: systemImage.mimeType || "image/png",
                                    },
                                ]
                              : [];
                    if (images.length === 0) {
                        return;
                    }
                    const imgDirPath = joinPath(fileInfo.dir, "img");
                    const imgDirUri = await model.formatRemoteUri(imgDirPath, globalStore.get);
                    try {
                        await RpcApi.FileMkdirCommand(TabRpcClient, {
                            info: { path: imgDirUri },
                        });
                    } catch (mkdirErr) {
                        const dirInfo = await RpcApi.FileInfoCommand(TabRpcClient, {
                            info: { path: imgDirUri },
                        });
                        if (!dirInfo?.isdir) {
                            throw mkdirErr;
                        }
                    }

                    const insertedRefs: string[] = [];
                    for (const [index, image] of images.entries()) {
                        const fileName = makePastedImageName(
                            image.blob ?? new Blob([], { type: image.mimeType }),
                            index
                        );
                        const imagePath = joinPath(imgDirPath, fileName);
                        const imageUri = await model.formatRemoteUri(imagePath, globalStore.get);
                        await RpcApi.FileWriteCommand(TabRpcClient, {
                            info: { path: imageUri },
                            data64:
                                image.data64 ??
                                base64.fromByteArray(new Uint8Array(await image.blob.arrayBuffer())),
                        });
                        insertedRefs.push(makeMarkdownImageReference(fileName));
                    }

                    const selection = editor.getSelection();
                    if (!selection) {
                        return;
                    }
                    const insertionText = buildImageInsertionText(editor, insertedRefs);
                    editor.executeEdits("markdown-image-paste", [
                        {
                            range: selection,
                            text: insertionText,
                            forceMoveMarkers: true,
                        },
                    ]);
                    editor.pushUndoStop();

                } catch (err) {
                    pushNotification({
                        icon: "triangle-exclamation",
                        title: "粘贴图片失败",
                        message: `${err}`,
                        timestamp: new Date().toLocaleString(),
                        type: "error",
                    });
                }
            });
        };
        window.addEventListener("paste", handleWindowPasteCapture, true);

        const isFocused = globalStore.get(model.nodeModel.isFocused);
        if (isFocused) {
            editor.focus();
        }

        return () => {
            setPreviewModelEditorViewState(model, fileName, editor.saveViewState());
            keyDownDisposer.dispose();
            blurDisposer.dispose();
            window.removeEventListener("paste", handleWindowPasteCapture, true);
        };
    }

    function handleEditorChange(text: string) {
        // Ignore Monaco events that simply replay the current prop value.
        // Without this, an initial empty change can get treated as a user edit
        // and block the real file contents from ever replacing it.
        if (text === fileContent) {
            return;
        }
        setNewFileContent(text);
    }

    return (
        <CodeEditor
            blockId={model.blockId}
            text={fileContent}
            fileName={fileName}
            language={language}
            readonly={fileInfo.readonly}
            fontSizeOverride={isMarkdownFile ? 14 : undefined}
            onChange={handleEditorChange}
            onMount={onMount}
        />
    );
}

function CodeEditPreview({ model }: SpecializedViewProps) {
    useEffect(() => {
        model.codeEditKeyDownHandler = createCodeEditKeyDownHandler(model);
        model.refreshCallback = model.triggerRefresh;
        return () => {
            model.codeEditKeyDownHandler = null;
            model.monacoRef.current = null;
            model.refreshCallback = null;
        };
    }, [model]);

    return <CodeEditPane model={model} />;
}

export { CodeEditPane, CodeEditPreview };
