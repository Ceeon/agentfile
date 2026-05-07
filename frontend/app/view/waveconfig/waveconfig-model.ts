// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { getApi, getBlockMetaKeyAtom, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { SettingsVisualContent } from "@/app/view/waveconfig/settingsvisual";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { SecretsContent } from "@/app/view/waveconfig/secretscontent";
import { WaveConfigView } from "@/app/view/waveconfig/waveconfig";
import { isWindows } from "@/util/platformutil";
import { base64ToString, stringToBase64 } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import * as React from "react";

type ValidationResult = { success: true } | { error: string };
type ConfigValidator = (parsed: any) => ValidationResult;

export type ConfigFile = {
    name: string;
    path: string;
    language?: string;
    deprecated?: boolean;
    description?: string;
    docsUrl?: string;
    validator?: ConfigValidator;
    isSecrets?: boolean;
    hasJsonView?: boolean;
    visualComponent?: React.ComponentType<{ model: WaveConfigViewModel }>;
};

export const SecretNameRegex = /^[A-Za-z][A-Za-z0-9_]*$/;

function validateBgJson(parsed: any): ValidationResult {
    const keys = Object.keys(parsed);
    for (const key of keys) {
        if (!key.startsWith("bg@")) {
            return { error: `Invalid key "${key}": all top-level keys must start with "bg@"` };
        }
    }
    return { success: true };
}

function validateAiJson(parsed: any): ValidationResult {
    const keys = Object.keys(parsed);
    for (const key of keys) {
        if (!key.startsWith("ai@")) {
            return { error: `Invalid key "${key}": all top-level keys must start with "ai@"` };
        }
    }
    return { success: true };
}

function validateWaveAiJson(parsed: any): ValidationResult {
    const keys = Object.keys(parsed);
    const keyPattern = /^[a-zA-Z0-9_@.-]+$/;
    for (const key of keys) {
        if (!keyPattern.test(key)) {
            return {
                error: `无效键名“${key}”：键名只能包含字母、数字、下划线、@、点和连字符`,
            };
        }
    }
    return { success: true };
}

const configFiles: ConfigFile[] = [
    {
        name: "通用",
        path: "settings.json",
        language: "json",
        docsUrl: "https://docs.waveterm.dev/config",
        hasJsonView: true,
        visualComponent: SettingsVisualContent,
    },
    {
        name: "连接",
        path: "connections.json",
        language: "json",
        docsUrl: "https://docs.waveterm.dev/connections",
        description: isWindows() ? "SSH 主机与 WSL 发行版" : "SSH 主机",
        hasJsonView: true,
    },
    {
        name: "侧边栏组件",
        path: "widgets.json",
        language: "json",
        docsUrl: "https://docs.waveterm.dev/customwidgets",
        hasJsonView: true,
    },
    {
        name: "AI 模式",
        path: "waveai.json",
        language: "json",
        description: "本地模型与自带密钥",
        docsUrl: "https://docs.waveterm.dev/waveai-modes",
        validator: validateWaveAiJson,
        hasJsonView: true,
        // visualComponent: WaveAIVisualContent,
    },
    {
        name: "标签背景",
        path: "presets/bg.json",
        language: "json",
        docsUrl: "https://docs.waveterm.dev/presets#background-configurations",
        validator: validateBgJson,
        hasJsonView: true,
    },
    {
        name: "密钥",
        path: "secrets",
        isSecrets: true,
        hasJsonView: false,
        visualComponent: SecretsContent,
    },
];

const deprecatedConfigFiles: ConfigFile[] = [
    {
        name: "预设",
        path: "presets.json",
        language: "json",
        deprecated: true,
        hasJsonView: true,
    },
    {
        name: "AI 预设",
        path: "presets/ai.json",
        language: "json",
        deprecated: true,
        docsUrl: "https://docs.waveterm.dev/ai-presets",
        validator: validateAiJson,
        hasJsonView: true,
    },
];

export class WaveConfigViewModel implements ViewModel {
    blockId: string;
    viewType = "waveconfig";
    viewIcon = atom("gear");
    viewName = atom("配置");
    viewComponent = WaveConfigView;
    noPadding = atom(true);
    nodeModel: BlockNodeModel;
    tabModel: TabModel;

    selectedFileAtom: PrimitiveAtom<ConfigFile>;
    fileContentAtom: PrimitiveAtom<string>;
    originalContentAtom: PrimitiveAtom<string>;
    hasEditedAtom: PrimitiveAtom<boolean>;
    isLoadingAtom: PrimitiveAtom<boolean>;
    isSavingAtom: PrimitiveAtom<boolean>;
    errorMessageAtom: PrimitiveAtom<string>;
    validationErrorAtom: PrimitiveAtom<string>;
    isMenuOpenAtom: PrimitiveAtom<boolean>;
    presetsJsonExistsAtom: PrimitiveAtom<boolean>;
    activeTabAtom: PrimitiveAtom<"visual" | "json">;
    configDir: string;
    saveShortcut: string;
    editorRef: React.RefObject<MonacoTypes.editor.IStandaloneCodeEditor>;

    secretNamesAtom: PrimitiveAtom<string[]>;
    selectedSecretAtom: PrimitiveAtom<string | null>;
    secretValueAtom: PrimitiveAtom<string>;
    secretShownAtom: PrimitiveAtom<boolean>;
    isAddingNewAtom: PrimitiveAtom<boolean>;
    newSecretNameAtom: PrimitiveAtom<string>;
    newSecretValueAtom: PrimitiveAtom<string>;
    storageBackendErrorAtom: PrimitiveAtom<string | null>;
    secretValueRef: HTMLTextAreaElement | null = null;

    constructor(blockId: string, nodeModel: BlockNodeModel, tabModel: TabModel) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.configDir = getApi().getConfigDir();
        const platform = getApi().getPlatform();
        this.saveShortcut = platform === "darwin" ? "Cmd+S" : "Alt+S";

        this.selectedFileAtom = atom(null) as PrimitiveAtom<ConfigFile>;
        this.fileContentAtom = atom("");
        this.originalContentAtom = atom("");
        this.hasEditedAtom = atom(false);
        this.isLoadingAtom = atom(false);
        this.isSavingAtom = atom(false);
        this.errorMessageAtom = atom(null) as PrimitiveAtom<string>;
        this.validationErrorAtom = atom(null) as PrimitiveAtom<string>;
        this.isMenuOpenAtom = atom(false);
        this.presetsJsonExistsAtom = atom(false);
        this.activeTabAtom = atom<"visual" | "json">("visual");
        this.editorRef = React.createRef();

        this.secretNamesAtom = atom<string[]>([]);
        this.selectedSecretAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
        this.secretValueAtom = atom<string>("");
        this.secretShownAtom = atom<boolean>(false);
        this.isAddingNewAtom = atom<boolean>(false);
        this.newSecretNameAtom = atom<string>("");
        this.newSecretValueAtom = atom<string>("");
        this.storageBackendErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

        this.checkPresetsJsonExists();
        this.initialize();
    }

    async checkPresetsJsonExists() {
        try {
            const fullPath = `${this.configDir}/presets.json`;
            const fileInfo = await RpcApi.FileInfoCommand(TabRpcClient, {
                info: { path: fullPath },
            });
            if (!fileInfo.notfound) {
                globalStore.set(this.presetsJsonExistsAtom, true);
            }
        } catch {
            // File doesn't exist
        }
    }

    initialize() {
        const selectedFile = globalStore.get(this.selectedFileAtom);
        if (!selectedFile) {
            const metaFileAtom = getBlockMetaKeyAtom(this.blockId, "file");
            const savedFilePath = globalStore.get(metaFileAtom);

            let fileToLoad: ConfigFile | null = null;
            if (savedFilePath) {
                fileToLoad =
                    configFiles.find((f) => f.path === savedFilePath) ||
                    deprecatedConfigFiles.find((f) => f.path === savedFilePath) ||
                    null;
            }

            if (!fileToLoad) {
                fileToLoad = configFiles[0];
            }

            if (fileToLoad) {
                this.loadFile(fileToLoad);
            }
        }
    }

    getConfigFiles(): ConfigFile[] {
        return configFiles;
    }

    getDeprecatedConfigFiles(): ConfigFile[] {
        const presetsJsonExists = globalStore.get(this.presetsJsonExistsAtom);
        return deprecatedConfigFiles.filter((f) => {
            if (f.path === "presets.json") {
                return presetsJsonExists;
            }
            return true;
        });
    }

    hasChanges(): boolean {
        return globalStore.get(this.hasEditedAtom);
    }

    markAsEdited() {
        globalStore.set(this.hasEditedAtom, true);
    }

    async loadFile(file: ConfigFile) {
        globalStore.set(this.isLoadingAtom, true);
        globalStore.set(this.errorMessageAtom, null);
        globalStore.set(this.hasEditedAtom, false);

        if (file.isSecrets) {
            globalStore.set(this.selectedFileAtom, file);
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
                meta: { file: file.path },
            });
            globalStore.set(this.isLoadingAtom, false);
            this.checkStorageBackend();
            this.refreshSecrets();
            return;
        }

        try {
            const fullPath = `${this.configDir}/${file.path}`;
            const fileData = await RpcApi.FileReadCommand(TabRpcClient, {
                info: { path: fullPath },
            });
            const content = fileData?.data64 ? base64ToString(fileData.data64) : "";
            globalStore.set(this.originalContentAtom, content);
            if (content.trim() === "") {
                globalStore.set(this.fileContentAtom, "{\n\n}");
            } else {
                globalStore.set(this.fileContentAtom, content);
            }
            globalStore.set(this.selectedFileAtom, file);
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
                meta: { file: file.path },
            });
        } catch (err) {
            globalStore.set(this.errorMessageAtom, `加载 ${file.name} 失败：${err.message || String(err)}`);
            globalStore.set(this.fileContentAtom, "");
            globalStore.set(this.originalContentAtom, "");
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    async saveFile() {
        const selectedFile = globalStore.get(this.selectedFileAtom);
        if (!selectedFile) return;

        const fileContent = globalStore.get(this.fileContentAtom);

        if (fileContent.trim() === "") {
            globalStore.set(this.isSavingAtom, true);
            globalStore.set(this.errorMessageAtom, null);
            globalStore.set(this.validationErrorAtom, null);

            try {
                const fullPath = `${this.configDir}/${selectedFile.path}`;
                await RpcApi.FileWriteCommand(TabRpcClient, {
                    info: { path: fullPath },
                    data64: stringToBase64(""),
                });
                globalStore.set(this.fileContentAtom, "");
                globalStore.set(this.originalContentAtom, "");
                globalStore.set(this.hasEditedAtom, false);
            } catch (err) {
                globalStore.set(
                    this.errorMessageAtom,
                    `保存 ${selectedFile.name} 失败：${err.message || String(err)}`
                );
            } finally {
                globalStore.set(this.isSavingAtom, false);
            }
            return;
        }

        try {
            const parsed = JSON.parse(fileContent);

            if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
                globalStore.set(this.validationErrorAtom, "JSON 必须是对象，不能是数组、基础类型或 null");
                return;
            }

            if (selectedFile.validator) {
                const validationResult = selectedFile.validator(parsed);
                if ("error" in validationResult) {
                    globalStore.set(this.validationErrorAtom, validationResult.error);
                    return;
                }
            }

            const formatted = JSON.stringify(parsed, null, 2);

            globalStore.set(this.isSavingAtom, true);
            globalStore.set(this.errorMessageAtom, null);
            globalStore.set(this.validationErrorAtom, null);

            try {
                const fullPath = `${this.configDir}/${selectedFile.path}`;
                await RpcApi.FileWriteCommand(TabRpcClient, {
                    info: { path: fullPath },
                    data64: stringToBase64(formatted),
                });
                globalStore.set(this.fileContentAtom, formatted);
                globalStore.set(this.originalContentAtom, formatted);
                globalStore.set(this.hasEditedAtom, false);
            } catch (err) {
                globalStore.set(
                    this.errorMessageAtom,
                    `保存 ${selectedFile.name} 失败：${err.message || String(err)}`
                );
            } finally {
                globalStore.set(this.isSavingAtom, false);
            }
        } catch (err) {
            globalStore.set(this.validationErrorAtom, `JSON 无效：${err.message || String(err)}`);
        }
    }

    clearError() {
        globalStore.set(this.errorMessageAtom, null);
    }

    clearValidationError() {
        globalStore.set(this.validationErrorAtom, null);
    }

    async checkStorageBackend() {
        try {
            const backend = await RpcApi.GetSecretsLinuxStorageBackendCommand(TabRpcClient);
            if (backend === "basic_text" || backend === "unknown") {
                globalStore.set(
                    this.storageBackendErrorAtom,
                    "未找到合适的密钥管理器，无法安全管理密钥。"
                );
            } else {
                globalStore.set(this.storageBackendErrorAtom, null);
            }
        } catch (error) {
            globalStore.set(this.storageBackendErrorAtom, `检查密钥存储后端失败：${error.message}`);
        }
    }

    async refreshSecrets() {
        globalStore.set(this.isLoadingAtom, true);
        globalStore.set(this.errorMessageAtom, null);

        try {
            const names = await RpcApi.GetSecretsNamesCommand(TabRpcClient);
            globalStore.set(this.secretNamesAtom, names || []);
        } catch (error) {
            globalStore.set(this.errorMessageAtom, `加载密钥列表失败：${error.message}`);
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    async viewSecret(name: string) {
        globalStore.set(this.errorMessageAtom, null);
        globalStore.set(this.selectedSecretAtom, name);
        globalStore.set(this.secretShownAtom, false);
        globalStore.set(this.secretValueAtom, "");
    }

    closeSecretView() {
        globalStore.set(this.selectedSecretAtom, null);
        globalStore.set(this.secretValueAtom, "");
        globalStore.set(this.errorMessageAtom, null);
    }

    async showSecret() {
        const selectedSecret = globalStore.get(this.selectedSecretAtom);
        if (!selectedSecret) {
            return;
        }

        globalStore.set(this.isLoadingAtom, true);
        globalStore.set(this.errorMessageAtom, null);

        try {
            const secrets = await RpcApi.GetSecretsCommand(TabRpcClient, [selectedSecret]);
            const value = secrets[selectedSecret];
            if (value !== undefined) {
                globalStore.set(this.secretValueAtom, value);
                globalStore.set(this.secretShownAtom, true);
            } else {
                globalStore.set(this.errorMessageAtom, `未找到密钥：${selectedSecret}`);
            }
        } catch (error) {
            globalStore.set(this.errorMessageAtom, `加载密钥失败：${error.message}`);
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    async saveSecret() {
        const selectedSecret = globalStore.get(this.selectedSecretAtom);
        const secretValue = globalStore.get(this.secretValueAtom);

        if (!selectedSecret) {
            return;
        }

        globalStore.set(this.isLoadingAtom, true);
        globalStore.set(this.errorMessageAtom, null);

        try {
            await RpcApi.SetSecretsCommand(TabRpcClient, { [selectedSecret]: secretValue });
            RpcApi.RecordTEventCommand(
                TabRpcClient,
                {
                    event: "action:other",
                    props: {
                        "action:type": "waveconfig:savesecret",
                    },
                },
                { noresponse: true }
            );
            this.closeSecretView();
        } catch (error) {
            globalStore.set(this.errorMessageAtom, `保存密钥失败：${error.message}`);
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    async deleteSecret() {
        const selectedSecret = globalStore.get(this.selectedSecretAtom);

        if (!selectedSecret) {
            return;
        }

        globalStore.set(this.isLoadingAtom, true);
        globalStore.set(this.errorMessageAtom, null);

        try {
            await RpcApi.SetSecretsCommand(TabRpcClient, { [selectedSecret]: null });
            this.closeSecretView();
            await this.refreshSecrets();
        } catch (error) {
            globalStore.set(this.errorMessageAtom, `删除密钥失败：${error.message}`);
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    startAddingSecret() {
        globalStore.set(this.isAddingNewAtom, true);
        globalStore.set(this.newSecretNameAtom, "");
        globalStore.set(this.newSecretValueAtom, "");
        globalStore.set(this.errorMessageAtom, null);
    }

    cancelAddingSecret() {
        globalStore.set(this.isAddingNewAtom, false);
        globalStore.set(this.newSecretNameAtom, "");
        globalStore.set(this.newSecretValueAtom, "");
        globalStore.set(this.errorMessageAtom, null);
    }

    async addNewSecret() {
        const name = globalStore.get(this.newSecretNameAtom).trim();
        const value = globalStore.get(this.newSecretValueAtom);

        if (!name) {
            globalStore.set(this.errorMessageAtom, "密钥名称不能为空");
            return;
        }

        if (!SecretNameRegex.test(name)) {
            globalStore.set(
                this.errorMessageAtom,
                "密钥名称无效：必须以字母开头，且只能包含字母、数字和下划线"
            );
            return;
        }

        const existingNames = globalStore.get(this.secretNamesAtom);
        if (existingNames.includes(name)) {
            globalStore.set(this.errorMessageAtom, `密钥“${name}”已存在`);
            return;
        }

        globalStore.set(this.isLoadingAtom, true);
        globalStore.set(this.errorMessageAtom, null);

        try {
            await RpcApi.SetSecretsCommand(TabRpcClient, { [name]: value });
            RpcApi.RecordTEventCommand(
                TabRpcClient,
                {
                    event: "action:other",
                    props: {
                        "action:type": "waveconfig:savesecret",
                    },
                },
                { noresponse: true }
            );
            globalStore.set(this.isAddingNewAtom, false);
            globalStore.set(this.newSecretNameAtom, "");
            globalStore.set(this.newSecretValueAtom, "");
            await this.refreshSecrets();
        } catch (error) {
            globalStore.set(this.errorMessageAtom, `新增密钥失败：${error.message}`);
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    giveFocus(): boolean {
        const selectedFile = globalStore.get(this.selectedFileAtom);
        if (selectedFile?.isSecrets && this.secretValueRef) {
            this.secretValueRef.focus();
            return true;
        }
        if (this.editorRef?.current) {
            this.editorRef.current.focus();
            return true;
        }
        return false;
    }
}
