// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Modal } from "@/app/modals/modal";
import { atoms, getApi } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

type TerminalOption = {
    value: ExternalTerminalApp;
    label: string;
    description: string;
    icon: string;
    available: boolean;
    supported: boolean;
    reason?: string;
};

function getFallbackTerminalApps(platform?: NodeJS.Platform): ExternalTerminalAppInfo[] {
    if (platform === "win32") {
        return [
            { value: "windows-terminal", label: "Windows Terminal", available: false, supported: true },
            { value: "powershell", label: "Windows PowerShell", available: true, supported: true },
            { value: "cmd", label: "Command Prompt", available: true, supported: true },
        ];
    }
    return [{ value: "terminal", label: "Terminal.app", available: true, supported: true }];
}

const terminalDescriptions: Partial<Record<ExternalTerminalApp, string>> = {
    terminal: "macOS 系统自带终端，稳定可用。",
    "windows-terminal": "Windows 推荐终端，支持打开目录、WSL 和 SSH 命令。",
    powershell: "Windows 自带 PowerShell，稳定可用。",
    pwsh: "新版跨平台 PowerShell，适合已经安装 PowerShell 7 的用户。",
    cmd: "Windows 命令提示符，作为最后兜底。",
    "git-bash": "Wave 内置连接已支持 Git Bash；外部窗口打开目录待适配。",
    ghostty: "用 Ghostty 打开目录和远程连接命令。",
    iterm2: "用 iTerm2 打开目录和远程连接命令。",
    cmux: "用 cmux 打开目录和 SSH 工作区。",
    warp: "常见的 AI 终端。检测安装状态，打开目录方式待适配。",
    wezterm: "跨平台终端。检测安装状态，打开目录方式待适配。",
    kitty: "跨平台 GPU 终端。检测安装状态，打开目录方式待适配。",
    alacritty: "跨平台 GPU 终端。检测安装状态，打开目录方式待适配。",
    rio: "跨平台终端。检测安装状态，打开目录方式待适配。",
    hyper: "基于 Web 技术的终端。检测安装状态，打开目录方式待适配。",
    tabby: "跨平台终端。检测安装状态，打开目录方式待适配。",
};

const terminalIcons: Partial<Record<ExternalTerminalApp, string>> = {
    auto: "fa-wand-magic-sparkles",
    terminal: "fa-terminal",
    "windows-terminal": "fa-window-maximize",
    powershell: "fa-square-terminal",
    pwsh: "fa-square-terminal",
    cmd: "fa-terminal",
    "git-bash": "fa-code-branch",
    ghostty: "fa-square-terminal",
    iterm2: "fa-square-terminal",
    cmux: "fa-layer-group",
    warp: "fa-bolt",
    wezterm: "fa-terminal",
    kitty: "fa-terminal",
    alacritty: "fa-gauge-high",
    rio: "fa-terminal",
    hyper: "fa-layer-group",
    tabby: "fa-table-cells",
};

function normalizeExternalTerminalApp(value: unknown): ExternalTerminalApp {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
    if (normalized === "windows-terminal" || normalized === "windows terminal" || normalized === "wt" || normalized === "wt.exe") {
        return "windows-terminal";
    }
    if (normalized === "powershell" || normalized === "powershell.exe" || normalized === "windows-powershell") {
        return "powershell";
    }
    if (normalized === "pwsh" || normalized === "pwsh.exe" || normalized === "powershell7" || normalized === "powershell-7") {
        return "pwsh";
    }
    if (normalized === "cmd" || normalized === "cmd.exe" || normalized === "command prompt" || normalized === "command-prompt") {
        return "cmd";
    }
    if (normalized === "gitbash" || normalized === "git-bash" || normalized === "git bash" || normalized === "git-bash.exe") {
        return "git-bash";
    }
    if (normalized === "ghostty" || normalized === "ghostty.app") {
        return "ghostty";
    }
    if (normalized === "iterm" || normalized === "iterm2" || normalized === "iterm.app" || normalized === "iterm2.app") {
        return "iterm2";
    }
    if (normalized === "cmux" || normalized === "cmux.app") {
        return "cmux";
    }
    if (normalized === "terminal" || normalized === "terminal.app") {
        return "terminal";
    }
    if (normalized === "warp" || normalized === "warp.app") {
        return "warp";
    }
    if (normalized === "wezterm" || normalized === "wezterm.app") {
        return "wezterm";
    }
    if (normalized === "kitty" || normalized === "kitty.app") {
        return "kitty";
    }
    if (normalized === "alacritty" || normalized === "alacritty.app") {
        return "alacritty";
    }
    if (normalized === "rio" || normalized === "rio.app") {
        return "rio";
    }
    if (normalized === "hyper" || normalized === "hyper.app") {
        return "hyper";
    }
    if (normalized === "tabby" || normalized === "tabby.app") {
        return "tabby";
    }
    return "auto";
}

function appToOption(app: ExternalTerminalAppInfo): TerminalOption {
    return {
        value: app.value,
        label: app.label,
        description: app.reason ?? terminalDescriptions[app.value] ?? "已纳入本地终端扫描。",
        icon: terminalIcons[app.value] ?? "fa-terminal",
        available: app.available,
        supported: app.supported,
        reason: app.reason,
    };
}

function makeTerminalOptions(
    apps: ExternalTerminalAppInfo[],
    selectedValue: ExternalTerminalApp,
    fallbackApps: ExternalTerminalAppInfo[]
): TerminalOption[] {
    const detectedApps = apps.length > 0 ? apps : fallbackApps;
    const detectedByValue = new Map(detectedApps.map((app) => [app.value, app]));
    const included = new Set<ExternalTerminalApp>(["auto"]);
    const options: TerminalOption[] = [
        {
            value: "auto",
            label: "自动",
            description: "优先使用已安装且已支持的终端。",
            icon: terminalIcons.auto ?? "fa-wand-magic-sparkles",
            available: true,
            supported: true,
        },
    ];

    for (const app of detectedApps) {
        if (included.has(app.value)) {
            continue;
        }
        options.push(appToOption(app));
        included.add(app.value);
    }

    if (selectedValue !== "auto" && !included.has(selectedValue)) {
        const selected = detectedByValue.get(selectedValue);
        if (selected != null) {
            options.push(appToOption(selected));
        }
    }

    return options;
}

function isRecommendedOption(option: TerminalOption) {
    return option.value === "auto" || (option.available && option.supported);
}

function getTerminalStatus(option: TerminalOption): { label: string; className: string } {
    if (option.value === "auto") {
        return {
            label: "自动",
            className: "border border-border bg-background text-muted-foreground",
        };
    }
    if (!option.available) {
        return {
            label: "未安装",
            className: "border border-border bg-background text-muted-foreground",
        };
    }
    if (!option.supported) {
        return {
            label: "待适配",
            className: "bg-amber-500/15 text-amber-500",
        };
    }
    return {
        label: "已安装",
        className: "bg-green-500/15 text-green-500",
    };
}

const TerminalOptionRow = memo(
    ({
        option,
        selected,
        disabled,
        topBorder,
        onSelect,
    }: {
        option: TerminalOption;
        selected: boolean;
        disabled: boolean;
        topBorder: boolean;
        onSelect: (option: TerminalOption) => unknown;
    }) => {
        const status = getTerminalStatus(option);
        return (
            <button
                key={option.value}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => onSelect(option)}
                className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
                    topBorder ? "border-t border-border" : "",
                    selected ? "bg-accentbg" : "bg-transparent",
                    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-hoverbg"
                )}
            >
                <div
                    className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                        selected ? "border-accent text-accent" : "border-border text-muted-foreground"
                    )}
                >
                    <i className={`fa-sharp fa-solid ${option.icon}`} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="font-medium text-primary">{option.label}</div>
                        {selected ? (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">当前</span>
                        ) : null}
                        <span className={cn("rounded-full px-2 py-0.5 text-xs", status.className)}>{status.label}</span>
                    </div>
                    <div className="mt-1 text-sm leading-5 text-muted-foreground">{option.description}</div>
                </div>
            </button>
        );
    }
);

TerminalOptionRow.displayName = "TerminalOptionRow";

const AppSettingsModal = memo(() => {
    const settings = useAtomValue(atoms.settingsAtom);
    const platform = getApi().getPlatform();
    const fallbackTerminalApps = useMemo(() => getFallbackTerminalApps(platform), [platform]);
    const configuredValue = normalizeExternalTerminalApp(settings?.["app:externalterminal"]);
    const [selectedValue, setSelectedValue] = useState<ExternalTerminalApp>(configuredValue);
    const [detectedTerminalApps, setDetectedTerminalApps] = useState<ExternalTerminalAppInfo[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [saveState, setSaveState] = useState<"idle" | "saved" | "error">("idle");
    const [errorMessage, setErrorMessage] = useState("");

    useEffect(() => {
        if (!isSaving) {
            setSelectedValue(configuredValue);
        }
    }, [configuredValue, isSaving]);

    useEffect(() => {
        let disposed = false;
        getApi()
            .listExternalTerminalApps()
            .then((apps) => {
                if (!disposed) {
                    setDetectedTerminalApps(Array.isArray(apps) ? apps : []);
                }
            })
            .catch(() => {
                if (!disposed) {
                    setDetectedTerminalApps(fallbackTerminalApps);
                }
            });
        return () => {
            disposed = true;
        };
    }, [fallbackTerminalApps]);

    useEffect(() => {
        if (saveState !== "saved") {
            return;
        }
        const timer = window.setTimeout(() => setSaveState("idle"), 1500);
        return () => window.clearTimeout(timer);
    }, [saveState]);

    const options = useMemo(
        () => makeTerminalOptions(detectedTerminalApps, selectedValue, fallbackTerminalApps),
        [detectedTerminalApps, fallbackTerminalApps, selectedValue]
    );
    const recommendedOptions = useMemo(() => options.filter(isRecommendedOption), [options]);
    const catalogOptions = useMemo(() => options.filter((option) => !isRecommendedOption(option)), [options]);

    const handleSelect = useCallback(
        async (option: TerminalOption) => {
            if (isSaving || selectedValue === option.value || !option.available || !option.supported) {
                return;
            }
            const nextValue = option.value;
            setSelectedValue(nextValue);
            setIsSaving(true);
            setSaveState("idle");
            setErrorMessage("");
            try {
                await RpcApi.SetConfigCommand(TabRpcClient, { "app:externalterminal": nextValue });
                setSaveState("saved");
            } catch (err) {
                setSelectedValue(configuredValue);
                setSaveState("error");
                setErrorMessage(err instanceof Error ? err.message : String(err));
            } finally {
                setIsSaving(false);
            }
        },
        [configuredValue, isSaving, selectedValue]
    );

    const closeModal = () => modalsModel.popModal();

    return (
        <Modal
            className="max-h-[calc(100vh-96px)] w-[680px] max-w-[calc(100vw-48px)] overflow-y-auto pt-7 pb-5"
            onClose={closeModal}
        >
            <div className="flex w-full flex-col gap-5">
                <div className="flex items-start justify-between gap-4 pr-10">
                    <div>
                        <h2 className="text-xl font-semibold leading-7 text-primary">设置</h2>
                        <div className="mt-1 text-sm text-muted-foreground">外部终端</div>
                    </div>
                    <div className="h-7 text-xs text-muted-foreground">
                        {isSaving ? "保存中..." : saveState === "saved" ? "已保存" : null}
                    </div>
                </div>

                <div className="space-y-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">可选终端</div>
                    <div className="overflow-hidden rounded-lg border border-border">
                        {recommendedOptions.map((option, index) => {
                            const selected = selectedValue === option.value;
                            const disabled = !option.available || !option.supported || isSaving;
                            return (
                                <TerminalOptionRow
                                    key={option.value}
                                    option={option}
                                    selected={selected}
                                    disabled={disabled}
                                    topBorder={index > 0}
                                    onSelect={handleSelect}
                                />
                            );
                        })}
                    </div>
                </div>

                {catalogOptions.length > 0 ? (
                    <div className="space-y-3">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">常见终端目录</div>
                        <div className="overflow-hidden rounded-lg border border-border">
                            {catalogOptions.map((option, index) => {
                                const selected = selectedValue === option.value;
                                const disabled = !option.available || !option.supported || isSaving;
                                return (
                                    <TerminalOptionRow
                                        key={option.value}
                                        option={option}
                                        selected={selected}
                                        disabled={disabled}
                                        topBorder={index > 0}
                                        onSelect={handleSelect}
                                    />
                                );
                            })}
                        </div>
                    </div>
                ) : null}

                {saveState === "error" ? (
                    <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                        {errorMessage || "保存失败"}
                    </div>
                ) : null}
            </div>
        </Modal>
    );
});

AppSettingsModal.displayName = "AppSettingsModal";

export { AppSettingsModal };
