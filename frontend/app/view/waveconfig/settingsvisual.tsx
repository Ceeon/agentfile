// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getApi } from "@/app/store/global";
import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { cn } from "@/util/util";
import { useAtom } from "jotai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

const terminalOptions: Array<{
    value: ExternalTerminalApp;
    label: string;
    description: string;
    icon: string;
}> = [
    {
        value: "auto",
        label: "自动",
        description: "自动检测当前系统已安装且已支持的终端。",
        icon: "fa-wand-magic-sparkles",
    },
];

function getFallbackDetectedTerminalApps(platform?: NodeJS.Platform): ExternalTerminalAppInfo[] {
    if (platform === "win32") {
        return [
            { value: "windows-terminal", label: "Windows Terminal", available: false, supported: true },
            { value: "powershell", label: "Windows PowerShell", available: true, supported: true },
            { value: "cmd", label: "Command Prompt", available: true, supported: true },
            { value: "git-bash", label: "Git Bash", available: false, supported: false },
            { value: "wezterm", label: "WezTerm", available: false, supported: true },
            { value: "alacritty", label: "Alacritty", available: false, supported: true },
            { value: "warp", label: "Warp", available: false, supported: false },
            { value: "tabby", label: "Tabby", available: false, supported: false },
        ];
    }
    return [
        { value: "ghostty", label: "Ghostty", available: false, supported: true },
        { value: "cmux", label: "cmux", available: false, supported: true },
        { value: "iterm2", label: "iTerm2", available: false, supported: true },
        { value: "terminal", label: "Terminal.app", available: true, supported: true },
        { value: "warp", label: "Warp", available: false, supported: false },
        { value: "wezterm", label: "WezTerm", available: false, supported: false },
        { value: "kitty", label: "Kitty", available: false, supported: false },
        { value: "alacritty", label: "Alacritty", available: false, supported: false },
        { value: "rio", label: "Rio", available: false, supported: false },
        { value: "hyper", label: "Hyper", available: false, supported: false },
        { value: "tabby", label: "Tabby", available: false, supported: false },
    ];
}

const terminalDescriptions: Partial<Record<ExternalTerminalApp, string>> = {
    terminal: "macOS 系统自带终端。稳定、默认可用。",
    "windows-terminal": "Windows 推荐终端，支持打开目录、WSL 和 SSH 命令。",
    powershell: "Windows 自带 PowerShell，稳定可用。",
    pwsh: "新版跨平台 PowerShell，适合已经安装 PowerShell 7 的用户。",
    cmd: "Windows 命令提示符，作为最后兜底。",
    "git-bash": "Wave 内置连接已支持 Git Bash；外部窗口打开目录待适配。",
    ghostty: "用 Ghostty 打开文件页和目录页里的“打开终端”动作。",
    cmux: "用 cmux 打开目录和 SSH 工作区。",
    iterm2: "用 iTerm2 打开对应目录或远程连接命令。",
    warp: "已纳入本地扫描，打开目录方式待适配。",
    wezterm: "已纳入本地扫描，打开目录方式待适配。",
    kitty: "已纳入本地扫描，打开目录方式待适配。",
    alacritty: "已纳入本地扫描，打开目录方式待适配。",
    rio: "已纳入本地扫描，打开目录方式待适配。",
    hyper: "已纳入本地扫描，打开目录方式待适配。",
    tabby: "已纳入本地扫描，打开目录方式待适配。",
};

const terminalIcons: Partial<Record<ExternalTerminalApp, string>> = {
    terminal: "fa-terminal",
    "windows-terminal": "fa-window-maximize",
    powershell: "fa-square-terminal",
    pwsh: "fa-square-terminal",
    cmd: "fa-terminal",
    "git-bash": "fa-code-branch",
    ghostty: "fa-ghost",
    cmux: "fa-layer-group",
    iterm2: "fa-square-terminal",
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

export const SettingsVisualContent = memo(({ model }: { model: WaveConfigViewModel }) => {
    const [fileContent, setFileContent] = useAtom(model.fileContentAtom);
    const [detectedTerminalApps, setDetectedTerminalApps] = useState<ExternalTerminalAppInfo[]>([]);
    const platform = getApi().getPlatform();
    const fallbackDetectedTerminalApps = useMemo(() => getFallbackDetectedTerminalApps(platform), [platform]);

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
                    setDetectedTerminalApps(fallbackDetectedTerminalApps);
                }
            });
        return () => {
            disposed = true;
        };
    }, [fallbackDetectedTerminalApps]);

    const parseResult = useMemo(() => {
        if (fileContent.trim() === "") {
            return { parsed: {} as Record<string, unknown>, error: null as string | null };
        }

        try {
            const parsed = JSON.parse(fileContent);
            if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
                return {
                    parsed: null,
                    error: "settings.json 必须是一个 JSON 对象。请先切到“原始 JSON”修正后再回来。",
                };
            }
            return { parsed: parsed as Record<string, unknown>, error: null as string | null };
        } catch (err) {
            return {
                parsed: null,
                error: `settings.json 不是有效 JSON：${err.message || String(err)}`,
            };
        }
    }, [fileContent]);

    const selectedValue = useMemo(
        () => normalizeExternalTerminalApp(parseResult.parsed?.["app:externalterminal"]),
        [parseResult.parsed]
    );

    const terminalAppsForView = useMemo(
        () => (detectedTerminalApps.length > 0 ? detectedTerminalApps : fallbackDetectedTerminalApps),
        [detectedTerminalApps, fallbackDetectedTerminalApps]
    );

    const detectedByValue = useMemo(() => {
        return new Map(terminalAppsForView.map((app) => [app.value, app]));
    }, [terminalAppsForView]);

    const visibleTerminalOptions = useMemo(() => {
        return [
            ...terminalOptions,
            ...terminalAppsForView.map((app) => ({
                value: app.value as ExternalTerminalApp,
                label: app.label,
                description: app.reason ?? terminalDescriptions[app.value] ?? "已纳入本地终端扫描。",
                icon: terminalIcons[app.value] ?? "fa-terminal",
            })),
        ];
    }, [terminalAppsForView]);

    const isTerminalOptionAvailable = useCallback(
        (value: ExternalTerminalApp) => {
            if (value === "auto") {
                return true;
            }
            const detected = detectedByValue.get(value);
            return detected == null ? value === "terminal" : detected.available && detected.supported;
        },
        [detectedByValue]
    );

    const handleSelect = useCallback(
        (value: ExternalTerminalApp) => {
            if (parseResult.parsed == null || selectedValue === value) {
                return;
            }

            const nextSettings = { ...parseResult.parsed };
            nextSettings["app:externalterminal"] = value;
            setFileContent(`${JSON.stringify(nextSettings, null, 2)}\n`);
            model.clearError();
            model.clearValidationError();
            model.markAsEdited();
        },
        [model, parseResult.parsed, selectedValue, setFileContent]
    );

    return (
        <div className="h-full overflow-auto">
            <div className="max-w-3xl p-6 space-y-6">
                <div className="space-y-2">
                    <h2 className="text-xl font-semibold">外部终端</h2>
                    <p className="text-sm text-muted-foreground">
                        这里决定“打开终端”按钮默认调用哪个终端应用。文件页和目录页里的终端按钮都会用这个设置。
                    </p>
                </div>

                {parseResult.error ? (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                        {parseResult.error}
                    </div>
                ) : (
                    <div className="rounded-2xl border border-border bg-background overflow-hidden">
                        <div className="border-b border-border px-5 py-4">
                            <div className="text-sm font-medium">默认终端</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {platform === "darwin"
                                    ? "当前平台是 macOS。这里的选择会直接影响“打开终端”按钮。"
                                    : platform === "win32"
                                      ? "当前平台是 Windows。这里的选择会直接影响“打开终端”按钮。"
                                      : "当前平台会按系统终端逻辑处理。"}
                            </div>
                        </div>

                        <div className="p-3 space-y-3">
                            {visibleTerminalOptions.map((option) => {
                                const isSelected = selectedValue === option.value;
                                const isAvailable = isTerminalOptionAvailable(option.value);
                                const detected = option.value === "auto" ? null : detectedByValue.get(option.value);
                                return (
                                    <button
                                        key={option.value}
                                        type="button"
                                        onClick={() => {
                                            if (isAvailable) {
                                                handleSelect(option.value);
                                            }
                                        }}
                                        disabled={!isAvailable}
                                        className={cn(
                                            "w-full rounded-xl border px-4 py-4 text-left transition-colors",
                                            isAvailable ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                                            isSelected
                                                ? "border-accent bg-accentbg"
                                                : "border-border bg-transparent hover:bg-secondary/40"
                                        )}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div
                                                className={cn(
                                                    "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                                                    isSelected
                                                        ? "border-accent text-accent"
                                                        : "border-border text-muted-foreground"
                                                )}
                                            >
                                                <i className={`fa-sharp fa-solid ${option.icon}`} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <div className="font-medium text-primary">{option.label}</div>
                                                    {isSelected && (
                                                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
                                                            当前使用
                                                        </span>
                                                    )}
                                                    {option.value === "auto" ? (
                                                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                                                            自动检测
                                                        </span>
                                                    ) : detected?.available && detected.supported ? (
                                                        <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-500">
                                                            已检测到
                                                        </span>
                                                    ) : detected?.available && !detected.supported ? (
                                                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500">
                                                            待适配
                                                        </span>
                                                    ) : (
                                                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                                                            未安装
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="mt-1 text-sm text-muted-foreground">
                                                    {option.description}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                <div className="rounded-xl border border-border bg-secondary/20 px-4 py-3 text-sm text-muted-foreground">
                    这里只管终端应用本身，不再给每个文件夹或按钮单独配路径。其他位置继续保持“点一下就打开”。
                </div>
            </div>
        </div>
    );
});

SettingsVisualContent.displayName = "SettingsVisualContent";
