// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import { FastAverageColor } from "fast-average-color";
import fs from "fs";
import * as child_process from "node:child_process";
import * as path from "path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { Readable } from "stream";
import { RpcApi } from "../frontend/app/store/wshclientapi";
import { getWebServerEndpoint } from "../frontend/util/endpoints";
import * as keyutil from "../frontend/util/keyutil";
import { fireAndForget, parseDataUrl } from "../frontend/util/util";
import { incrementTermCommandsRun } from "./emain-activity";
import { callWithOriginalXdgCurrentDesktopAsync, unamePlatform } from "./emain-platform";
import { getWaveTabViewByWebContentsId } from "./emain-tabview";
import { handleCtrlShiftState } from "./emain-util";
import { getWaveVersion } from "./emain-wavesrv";
import {
    createNewWaveWindow,
    focusedWaveWindow,
    getWaveWindowByWebContentsId,
    openFileInNewTab,
} from "./emain-window";
import { ElectronWshClient } from "./emain-wsh";

const electronApp = electron.app;

type UrlInSessionResult = {
    stream: Readable;
    mimeType: string;
    fileName: string;
};

type ExternalTerminalRequest = {
    cwd: string;
    connection?: string | null;
};

type DirectoryOpenTarget = "finder" | "terminal";

type OpenDirectoryTargetRequest = {
    target: DirectoryOpenTarget;
    cwd: string;
    connection?: string | null;
};

type ParsedTerminalConnection =
    | { kind: "local" }
    | { kind: "wsl"; distro: string }
    | { kind: "ssh"; target: string; port?: string };

type ExternalTerminalApp = MacExternalTerminalApp | WindowsExternalTerminalApp;
type MacExternalTerminalApp =
    | "auto"
    | "terminal"
    | "ghostty"
    | "iterm2"
    | "cmux"
    | "warp"
    | "wezterm"
    | "kitty"
    | "alacritty"
    | "rio"
    | "hyper"
    | "tabby";
type SupportedMacExternalTerminalApp = "terminal" | "ghostty" | "iterm2" | "cmux";
type ResolvedMacExternalTerminalApp = SupportedMacExternalTerminalApp;
type WindowsExternalTerminalApp =
    | "auto"
    | "windows-terminal"
    | "powershell"
    | "pwsh"
    | "cmd"
    | "git-bash"
    | "warp"
    | "wezterm"
    | "alacritty"
    | "tabby"
    | "cmux";
type SupportedWindowsExternalTerminalApp = "windows-terminal" | "powershell" | "pwsh" | "cmd" | "wezterm" | "alacritty";
type ResolvedWindowsExternalTerminalApp = SupportedWindowsExternalTerminalApp;
type ExternalTerminalAppInfo = {
    value: Exclude<ExternalTerminalApp, "auto">;
    label: string;
    available: boolean;
    supported: boolean;
    reason?: string;
};

type MacTerminalCatalogItem = {
    value: Exclude<MacExternalTerminalApp, "auto">;
    label: string;
    appNames: string[];
    appPaths?: string[];
    supported: boolean;
    priority: number;
    reason?: string;
};

type WindowsTerminalCatalogItem = {
    value: Exclude<WindowsExternalTerminalApp, "auto">;
    label: string;
    commands?: string[];
    paths?: string[];
    supported: boolean;
    priority: number;
    reason?: string;
};

function standardMacAppPaths(appBundleName: string): string[] {
    return [`/Applications/${appBundleName}.app`, `~/Applications/${appBundleName}.app`];
}

function standardWindowsAppPaths(executableName: string): string[] {
    return [
        `%LOCALAPPDATA%\\Microsoft\\WindowsApps\\${executableName}`,
        `%PROGRAMFILES%\\${path.basename(executableName, ".exe")}\\${executableName}`,
        `%PROGRAMFILES(X86)%\\${path.basename(executableName, ".exe")}\\${executableName}`,
    ];
}

const MacTerminalCatalog: MacTerminalCatalogItem[] = [
    {
        value: "ghostty",
        label: "Ghostty",
        appNames: ["Ghostty"],
        appPaths: standardMacAppPaths("Ghostty"),
        supported: true,
        priority: 100,
    },
    {
        value: "cmux",
        label: "cmux",
        appNames: ["cmux"],
        appPaths: standardMacAppPaths("cmux"),
        supported: true,
        priority: 95,
    },
    {
        value: "iterm2",
        label: "iTerm2",
        appNames: ["iTerm", "iTerm2"],
        appPaths: [...standardMacAppPaths("iTerm"), ...standardMacAppPaths("iTerm2")],
        supported: true,
        priority: 90,
    },
    {
        value: "terminal",
        label: "Terminal.app",
        appNames: ["Terminal"],
        appPaths: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"],
        supported: true,
        priority: 10,
    },
    {
        value: "warp",
        label: "Warp",
        appNames: ["Warp"],
        appPaths: standardMacAppPaths("Warp"),
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
    {
        value: "wezterm",
        label: "WezTerm",
        appNames: ["WezTerm"],
        appPaths: standardMacAppPaths("WezTerm"),
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
    {
        value: "kitty",
        label: "Kitty",
        appNames: ["kitty", "Kitty"],
        appPaths: [...standardMacAppPaths("kitty"), ...standardMacAppPaths("Kitty")],
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
    {
        value: "alacritty",
        label: "Alacritty",
        appNames: ["Alacritty"],
        appPaths: standardMacAppPaths("Alacritty"),
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
    {
        value: "rio",
        label: "Rio",
        appNames: ["Rio"],
        appPaths: standardMacAppPaths("Rio"),
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
    {
        value: "hyper",
        label: "Hyper",
        appNames: ["Hyper"],
        appPaths: standardMacAppPaths("Hyper"),
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
    {
        value: "tabby",
        label: "Tabby",
        appNames: ["Tabby"],
        appPaths: standardMacAppPaths("Tabby"),
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
];

const WindowsTerminalCatalog: WindowsTerminalCatalogItem[] = [
    {
        value: "windows-terminal",
        label: "Windows Terminal",
        commands: ["wt.exe"],
        paths: ["%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe"],
        supported: true,
        priority: 100,
    },
    {
        value: "wezterm",
        label: "WezTerm",
        commands: ["wezterm.exe"],
        paths: standardWindowsAppPaths("wezterm.exe"),
        supported: true,
        priority: 90,
    },
    {
        value: "alacritty",
        label: "Alacritty",
        commands: ["alacritty.exe"],
        paths: standardWindowsAppPaths("alacritty.exe"),
        supported: true,
        priority: 80,
    },
    {
        value: "pwsh",
        label: "PowerShell 7",
        commands: ["pwsh.exe"],
        paths: ["%PROGRAMFILES%\\PowerShell\\7\\pwsh.exe", "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\pwsh.exe"],
        supported: true,
        priority: 50,
    },
    {
        value: "powershell",
        label: "Windows PowerShell",
        commands: ["powershell.exe"],
        paths: ["%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
        supported: true,
        priority: 40,
    },
    {
        value: "cmd",
        label: "Command Prompt",
        commands: ["cmd.exe"],
        paths: ["%COMSPEC%", "%SYSTEMROOT%\\System32\\cmd.exe"],
        supported: true,
        priority: 10,
    },
    {
        value: "git-bash",
        label: "Git Bash",
        commands: ["git-bash.exe"],
        paths: [
            "%PROGRAMFILES%\\Git\\git-bash.exe",
            "%LOCALAPPDATA%\\Programs\\Git\\git-bash.exe",
            "%USERPROFILE%\\scoop\\apps\\git\\current\\git-bash.exe",
        ],
        supported: false,
        priority: 0,
        reason: "Wave 内置连接已支持 Git Bash；外部窗口打开目录待适配。",
    },
    {
        value: "warp",
        label: "Warp",
        commands: ["warp.exe"],
        paths: standardWindowsAppPaths("warp.exe"),
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
    {
        value: "tabby",
        label: "Tabby",
        commands: ["Tabby.exe", "tabby.exe"],
        paths: standardWindowsAppPaths("Tabby.exe"),
        supported: false,
        priority: 0,
        reason: "已检测到，暂未适配打开目录参数。",
    },
    {
        value: "cmux",
        label: "cmux",
        commands: ["cmux.exe"],
        paths: standardWindowsAppPaths("cmux.exe"),
        supported: false,
        priority: 0,
        reason: "已检测到，Windows 外部窗口打开方式待适配。",
    },
];

const sshConnRe = /^([a-zA-Z0-9][a-zA-Z0-9._@\\-]*@)?([a-zA-Z0-9][a-zA-Z0-9.-]*)(?::([0-9]+))?$/;

function shellEscapePosix(value: string): string {
    return `'${(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function shellEscapePosixPath(value: string): string {
    if (value === "~") {
        return "~";
    }
    if (value?.startsWith("~/")) {
        return `~/${shellEscapePosix(value.slice(2))}`;
    }
    return shellEscapePosix(value);
}

function joinShellArgs(args: string[]): string {
    return args.map((arg) => shellEscapePosix(arg)).join(" ");
}

function shellEscapePowerShell(value: string): string {
    return `'${(value ?? "").replace(/'/g, "''")}'`;
}

function joinPowerShellArgs(args: string[]): string {
    return args.map((arg) => shellEscapePowerShell(arg)).join(" ");
}

function quoteCmdArg(value: string): string {
    if (/^[a-zA-Z0-9_@%+=:,./\\-]+$/.test(value ?? "")) {
        return value;
    }
    return `"${(value ?? "").replace(/"/g, '\\"')}"`;
}

function joinCmdArgs(args: string[]): string {
    return args.map((arg) => quoteCmdArg(arg)).join(" ");
}

function spawnDetached(command: string, args: string[], options?: child_process.SpawnOptions) {
    const child = child_process.spawn(command, args, {
        ...options,
        detached: true,
        stdio: "ignore",
    });
    child.unref();
}

function expandLocalHomePath(filePath: string): string {
    if (filePath === "~") {
        return electronApp.getPath("home");
    }
    if (filePath?.startsWith("~/")) {
        return path.join(electronApp.getPath("home"), filePath.slice(2));
    }
    return filePath;
}

function getEnvValue(name: string): string | undefined {
    return process.env[name] ?? process.env[name.toUpperCase()] ?? process.env[name.toLowerCase()];
}

function getWindowsLocalPath(filePath: string): string {
    const expanded = expandLocalHomePath(filePath);
    const gitBashDrivePathMatch = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(expanded);
    if (gitBashDrivePathMatch != null) {
        const drive = gitBashDrivePathMatch[1].toUpperCase();
        const rest = gitBashDrivePathMatch[2]?.replace(/\//g, "\\") ?? "";
        return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
    }
    return expanded;
}

function normalizeExternalTerminalApp(value?: string | null): ExternalTerminalApp {
    const normalized = value?.trim()?.toLowerCase();
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

function normalizeMacExternalTerminalApp(value?: string | null): MacExternalTerminalApp {
    const normalized = normalizeExternalTerminalApp(value);
    if (MacTerminalCatalog.some((terminal) => terminal.value === normalized)) {
        return normalized as MacExternalTerminalApp;
    }
    return normalized === "auto" ? "auto" : "auto";
}

function normalizeWindowsExternalTerminalApp(value?: string | null): WindowsExternalTerminalApp {
    const normalized = normalizeExternalTerminalApp(value);
    if (WindowsTerminalCatalog.some((terminal) => terminal.value === normalized)) {
        return normalized as WindowsExternalTerminalApp;
    }
    return normalized === "auto" ? "auto" : "auto";
}

function isMacAppAvailable(appName: string): boolean {
    try {
        child_process.execFileSync("/usr/bin/open", ["-Ra", appName], {
            stdio: "ignore",
            timeout: 2000,
        });
        return true;
    } catch {
        return false;
    }
}

function findAvailableMacApp(appNames: string[]): string | null {
    for (const appName of appNames) {
        if (isMacAppAvailable(appName)) {
            return appName;
        }
    }
    return null;
}

function findAvailableMacTerminalPath(terminal: MacTerminalCatalogItem): string | null {
    for (const appPath of terminal.appPaths ?? []) {
        if (fs.existsSync(expandLocalHomePath(appPath))) {
            return appPath;
        }
    }
    return null;
}

function findAvailableMacTerminal(terminal: MacTerminalCatalogItem): string | null {
    const appPath = findAvailableMacTerminalPath(terminal);
    if (appPath != null) {
        return appPath;
    }
    return findAvailableMacApp(terminal.appNames);
}

function isMacAppAvailableAsync(appName: string): Promise<boolean> {
    return new Promise((resolve) => {
        child_process.execFile("/usr/bin/open", ["-Ra", appName], { timeout: 1200 }, (err) => {
            resolve(err == null);
        });
    });
}

async function findAvailableMacAppAsync(appNames: string[]): Promise<string | null> {
    const results = await Promise.all(appNames.map(async (appName) => ((await isMacAppAvailableAsync(appName)) ? appName : null)));
    return results.find((appName): appName is string => appName != null) ?? null;
}

async function findAvailableMacTerminalAsync(terminal: MacTerminalCatalogItem): Promise<string | null> {
    const appPath = findAvailableMacTerminalPath(terminal);
    if (appPath != null) {
        return appPath;
    }
    return findAvailableMacAppAsync(terminal.appNames);
}

function findExecutableOnPath(command: string): string | null {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) {
            continue;
        }
        const candidate = path.join(dir, command);
        try {
            fs.accessSync(candidate, unamePlatform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
            return candidate;
        } catch {
            // Continue scanning PATH.
        }
    }
    return null;
}

function expandWindowsEnvPath(filePath: string): string {
    return expandLocalHomePath(filePath).replace(/%([^%]+)%/g, (match, envName) => getEnvValue(String(envName)) ?? match);
}

function findFirstExistingExecutable(candidates: string[]): string | null {
    for (const candidate of candidates) {
        const expanded = unamePlatform === "win32" ? expandWindowsEnvPath(candidate) : expandLocalHomePath(candidate);
        if (expanded.includes("%")) {
            continue;
        }
        try {
            fs.accessSync(expanded, unamePlatform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
            return expanded;
        } catch {
            // Try next location.
        }
    }
    return null;
}

function findCmuxExecutable(): string | null {
    const candidates = [
        "/Applications/cmux.app/Contents/Resources/bin/cmux",
        "/Applications/cmux.app/Contents/MacOS/cmux",
        "~/Applications/cmux.app/Contents/Resources/bin/cmux",
        "~/Applications/cmux.app/Contents/MacOS/cmux",
    ];
    for (const candidate of candidates) {
        const expanded = expandLocalHomePath(candidate);
        try {
            fs.accessSync(expanded, fs.constants.X_OK);
            return expanded;
        } catch {
            // Try next location.
        }
    }
    return findExecutableOnPath("cmux");
}

function findGitBashExecutable(configuredPath?: string | null): string | null {
    const candidates = [
        configuredPath,
        "%PROGRAMFILES%\\Git\\git-bash.exe",
        "%LOCALAPPDATA%\\Programs\\Git\\git-bash.exe",
        "%USERPROFILE%\\scoop\\apps\\git\\current\\git-bash.exe",
    ].filter((candidate): candidate is string => Boolean(candidate));
    return findFirstExistingExecutable(candidates) ?? findExecutableOnPath("git-bash.exe");
}

function findAvailableWindowsTerminal(terminal: WindowsTerminalCatalogItem, configuredGitBashPath?: string | null): string | null {
    if (terminal.value === "git-bash") {
        return findGitBashExecutable(configuredGitBashPath);
    }
    const pathMatch = findFirstExistingExecutable(terminal.paths ?? []);
    if (pathMatch != null) {
        return pathMatch;
    }
    for (const command of terminal.commands ?? []) {
        const commandMatch = findExecutableOnPath(command);
        if (commandMatch != null) {
            return commandMatch;
        }
    }
    if (terminal.value === "cmd") {
        return getEnvValue("COMSPEC") ?? "cmd.exe";
    }
    return null;
}

async function getFullConfigSettings(): Promise<Record<string, unknown>> {
    try {
        const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
        return fullConfig?.settings ?? {};
    } catch (err) {
        console.warn("error loading full config settings", err);
        return {};
    }
}

async function listExternalTerminalApps(): Promise<ExternalTerminalAppInfo[]> {
    if (unamePlatform === "win32") {
        const settings = await getFullConfigSettings();
        const configuredGitBashPath =
            typeof settings["term:gitbashpath"] === "string" ? (settings["term:gitbashpath"] as string) : null;
        return WindowsTerminalCatalog.map((terminal) => {
            const available = findAvailableWindowsTerminal(terminal, configuredGitBashPath) != null;
            return {
                value: terminal.value,
                label: terminal.label,
                available,
                supported: terminal.supported,
                reason: available && !terminal.supported ? terminal.reason : undefined,
            };
        });
    }
    if (unamePlatform !== "darwin") {
        return [{ value: "terminal", label: "System Terminal", available: true, supported: true }];
    }
    return Promise.all(MacTerminalCatalog.map(async (terminal) => {
        const available =
            terminal.value === "cmux" ? findCmuxExecutable() != null : (await findAvailableMacTerminalAsync(terminal)) != null;
        return {
            value: terminal.value,
            label: terminal.label,
            available,
            supported: terminal.supported,
            reason: available && !terminal.supported ? terminal.reason : undefined,
        };
    }));
}

function resolveMacExternalTerminalApp(app: MacExternalTerminalApp): ResolvedMacExternalTerminalApp {
    const requested = MacTerminalCatalog.find((terminal) => terminal.value === app);
    if (requested?.supported && (requested.value === "cmux" ? findCmuxExecutable() != null : findAvailableMacTerminal(requested) != null)) {
        return requested.value as SupportedMacExternalTerminalApp;
    }
    if (app === "auto") {
        const detected = MacTerminalCatalog.filter(
            (terminal) =>
                terminal.supported &&
                (terminal.value === "cmux" ? findCmuxExecutable() != null : findAvailableMacTerminal(terminal) != null)
        ).sort((a, b) => b.priority - a.priority);
        return (detected[0]?.value as SupportedMacExternalTerminalApp | undefined) ?? "terminal";
    }
    return "terminal";
}

function resolveWindowsExternalTerminalApp(
    app: WindowsExternalTerminalApp,
    configuredGitBashPath?: string | null
): ResolvedWindowsExternalTerminalApp {
    const requested = WindowsTerminalCatalog.find((terminal) => terminal.value === app);
    if (requested?.supported && findAvailableWindowsTerminal(requested, configuredGitBashPath) != null) {
        return requested.value as SupportedWindowsExternalTerminalApp;
    }
    if (app === "auto") {
        const detected = WindowsTerminalCatalog.filter(
            (terminal) => terminal.supported && findAvailableWindowsTerminal(terminal, configuredGitBashPath) != null
        ).sort((a, b) => b.priority - a.priority);
        return (detected[0]?.value as SupportedWindowsExternalTerminalApp | undefined) ?? "cmd";
    }
    return "cmd";
}

function buildGhosttyAppleScript(cwd: string, command?: string | null): string[] {
    const script = `
on run argv
    set targetCwd to ""
    set startupCommand to ""
    if (count of argv) > 0 then
        set targetCwd to item 1 of argv
    end if
    if (count of argv) > 1 then
        set startupCommand to item 2 of argv
    end if
    tell application "Ghostty"
        activate
        set cfg to new surface configuration
        if targetCwd is not "" then
            set initial working directory of cfg to targetCwd
        end if
        set win to new window with configuration cfg
        if startupCommand is not "" then
            set term1 to focused terminal of selected tab of win
            input text startupCommand to term1
            send key "enter" to term1
        end if
    end tell
end run`.trim();
    const args = ["-e", script, cwd];
    if (command) {
        args.push(command);
    }
    return args;
}

function parseTerminalConnection(connection?: string | null): ParsedTerminalConnection {
    if (connection == null || connection === "" || connection === "local" || connection.startsWith("local:")) {
        return { kind: "local" };
    }
    if (connection.startsWith("wsl://")) {
        return { kind: "wsl", distro: connection.slice("wsl://".length) };
    }
    const match = sshConnRe.exec(connection);
    if (match == null) {
        return null;
    }
    const sshUser = match[1]?.replace(/@$/, "") ?? "";
    const sshHost = match[2];
    const sshPort = match[3] ?? "";
    return {
        kind: "ssh",
        target: sshUser ? `${sshUser}@${sshHost}` : sshHost,
        port: sshPort || undefined,
    };
}

function buildExternalTerminalCommand(connection: string | null | undefined, cwd: string): string {
    const parsed = parseTerminalConnection(connection);
    if (parsed == null) {
        return null;
    }
    if (parsed.kind === "local") {
        const localCwd = expandLocalHomePath(cwd);
        return `cd ${shellEscapePosix(localCwd)}; clear`;
    }
    if (parsed.kind === "wsl") {
        return joinShellArgs(["wsl.exe", "-d", parsed.distro, "--cd", cwd]);
    }
    const remoteShell = `cd ${shellEscapePosixPath(cwd)} && exec $SHELL -l`;
    const sshArgs = ["ssh"];
    if (parsed.port) {
        sshArgs.push("-p", parsed.port);
    }
    sshArgs.push(parsed.target, "-t", remoteShell);
    return joinShellArgs(sshArgs);
}

function buildWindowsCommandArgs(connection: string | null | undefined, cwd: string): string[] | null {
    const parsed = parseTerminalConnection(connection);
    if (parsed == null) {
        return null;
    }
    if (parsed.kind === "local") {
        return null;
    }
    if (parsed.kind === "wsl") {
        return ["wsl.exe", "-d", parsed.distro, "--cd", cwd];
    }
    const remoteShell = `cd ${shellEscapePosixPath(cwd)} && exec $SHELL -l`;
    const sshArgs = ["ssh"];
    if (parsed.port) {
        sshArgs.push("-p", parsed.port);
    }
    sshArgs.push(parsed.target, "-t", remoteShell);
    return sshArgs;
}

function buildPowerShellTerminalCommand(connection: string | null | undefined, cwd: string): string | null {
    const parsed = parseTerminalConnection(connection);
    if (parsed == null) {
        return null;
    }
    if (parsed.kind === "local") {
        return `Set-Location -LiteralPath ${shellEscapePowerShell(getWindowsLocalPath(cwd))}; Clear-Host`;
    }
    const commandArgs = buildWindowsCommandArgs(connection, cwd);
    if (commandArgs == null) {
        return null;
    }
    return `& ${joinPowerShellArgs(commandArgs)}`;
}

function buildCmdTerminalCommand(connection: string | null | undefined, cwd: string): string | null {
    const parsed = parseTerminalConnection(connection);
    if (parsed == null) {
        return null;
    }
    if (parsed.kind === "local") {
        return `cd /d ${quoteCmdArg(getWindowsLocalPath(cwd))} && cls`;
    }
    const commandArgs = buildWindowsCommandArgs(connection, cwd);
    if (commandArgs == null) {
        return null;
    }
    return joinCmdArgs(commandArgs);
}

function buildWindowsTerminalArgs(connection: string | null | undefined, cwd: string): string[] | null {
    const parsed = parseTerminalConnection(connection);
    if (parsed == null) {
        return null;
    }
    if (parsed.kind === "local") {
        return ["-d", getWindowsLocalPath(cwd)];
    }
    return buildWindowsCommandArgs(connection, cwd);
}

function openGhostty(cwd: string, connection?: string | null) {
    const parsed = parseTerminalConnection(connection);
    if (parsed?.kind === "local") {
        spawnDetached("osascript", buildGhosttyAppleScript(expandLocalHomePath(cwd)));
        return;
    }
    const command = buildExternalTerminalCommand(connection, cwd);
    if (command == null) {
        electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
        return;
    }
    spawnDetached("osascript", buildGhosttyAppleScript("", command));
}

function buildItermAppleScript(command: string): string[] {
    const script = `
on run argv
    set startupCommand to ""
    if (count of argv) > 0 then
        set startupCommand to item 1 of argv
    end if
    tell application "iTerm2"
        activate
        set newWindow to (create window with default profile)
        tell current session of newWindow
            if startupCommand is not "" then
                write text startupCommand
            end if
        end tell
    end tell
end run`.trim();
    return ["-e", script, command];
}

function openIterm(cwd: string, connection?: string | null) {
    const command = buildExternalTerminalCommand(connection, cwd);
    if (command == null) {
        electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
        return;
    }
    spawnDetached("osascript", buildItermAppleScript(command));
}

function buildCmuxAppleScript(command: string): string[] {
    const script = `
on run argv
    set startupCommand to ""
    if (count of argv) > 0 then
        set startupCommand to item 1 of argv
    end if
    tell application "cmux"
        activate
        set newWin to new window
        delay 0.8
        set targetTerm to focused terminal of selected tab of front window
        if startupCommand is not "" then
            input text startupCommand to targetTerm
            perform action "text:\\r" on targetTerm
        end if
    end tell
end run`.trim();
    return ["-e", script, command];
}

function openCmux(cwd: string, connection?: string | null) {
    const terminal = MacTerminalCatalog.find((item) => item.value === "cmux");
    if (terminal == null || findAvailableMacTerminal(terminal) == null) {
        electron.dialog.showErrorBox("打开终端失败", "未找到 cmux。");
        return;
    }
    const command = buildExternalTerminalCommand(connection, cwd);
    if (command == null) {
        electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
        return;
    }
    spawnDetached("osascript", buildCmuxAppleScript(command));
}

function openMacTerminal(cwd: string, connection?: string | null, app: MacExternalTerminalApp = "auto") {
    const resolvedApp = resolveMacExternalTerminalApp(app);
    if (resolvedApp === "ghostty") {
        openGhostty(cwd, connection);
        return;
    }
    if (resolvedApp === "iterm2") {
        openIterm(cwd, connection);
        return;
    }
    if (resolvedApp === "cmux") {
        openCmux(cwd, connection);
        return;
    }
    const parsed = parseTerminalConnection(connection);
    if (parsed?.kind === "local") {
        spawnDetached("open", ["-a", "Terminal", expandLocalHomePath(cwd)]);
        return;
    }
    const command = buildExternalTerminalCommand(connection, cwd);
    if (command == null) {
        electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
        return;
    }
    spawnDetached("osascript", [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script ${JSON.stringify(command)}`,
    ]);
}

async function openWindowsTerminal(cwd: string, connection?: string | null, app: WindowsExternalTerminalApp = "auto") {
    const settings = await getFullConfigSettings();
    const configuredGitBashPath =
        typeof settings["term:gitbashpath"] === "string" ? (settings["term:gitbashpath"] as string) : null;
    const resolvedApp = resolveWindowsExternalTerminalApp(app, configuredGitBashPath);
    const terminal = WindowsTerminalCatalog.find((item) => item.value === resolvedApp);
    const executable = terminal ? findAvailableWindowsTerminal(terminal, configuredGitBashPath) : null;

    if (resolvedApp === "windows-terminal") {
        const args = buildWindowsTerminalArgs(connection, cwd);
        if (args == null) {
            electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
            return;
        }
        spawnDetached(executable ?? "wt.exe", args);
        return;
    }
    if (resolvedApp === "pwsh" || resolvedApp === "powershell") {
        const command = buildPowerShellTerminalCommand(connection, cwd);
        if (command == null) {
            electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
            return;
        }
        spawnDetached(executable ?? (resolvedApp === "pwsh" ? "pwsh.exe" : "powershell.exe"), [
            "-NoExit",
            "-Command",
            command,
        ]);
        return;
    }
    if (resolvedApp === "wezterm") {
        const parsed = parseTerminalConnection(connection);
        if (parsed == null) {
            electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
            return;
        }
        if (parsed.kind === "local") {
            spawnDetached(executable ?? "wezterm.exe", ["start", "--cwd", getWindowsLocalPath(cwd)]);
            return;
        }
        const args = buildWindowsCommandArgs(connection, cwd);
        if (args == null) {
            electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
            return;
        }
        spawnDetached(executable ?? "wezterm.exe", ["start", "--", ...args]);
        return;
    }
    if (resolvedApp === "alacritty") {
        const parsed = parseTerminalConnection(connection);
        if (parsed == null) {
            electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
            return;
        }
        if (parsed.kind === "local") {
            spawnDetached(executable ?? "alacritty.exe", ["--working-directory", getWindowsLocalPath(cwd)]);
            return;
        }
        const args = buildWindowsCommandArgs(connection, cwd);
        if (args == null) {
            electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
            return;
        }
        spawnDetached(executable ?? "alacritty.exe", ["-e", ...args]);
        return;
    }

    const command = buildCmdTerminalCommand(connection, cwd);
    if (command == null) {
        electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection ?? ""}`);
        return;
    }
    spawnDetached("cmd.exe", ["/c", "start", "", executable ?? "cmd.exe", "/K", command]);
}

async function getConfiguredMacExternalTerminalApp(): Promise<MacExternalTerminalApp> {
    const settings = await getFullConfigSettings();
    return normalizeMacExternalTerminalApp(
        typeof settings["app:externalterminal"] === "string" ? (settings["app:externalterminal"] as string) : null
    );
}

async function getConfiguredWindowsExternalTerminalApp(): Promise<WindowsExternalTerminalApp> {
    const settings = await getFullConfigSettings();
    return normalizeWindowsExternalTerminalApp(
        typeof settings["app:externalterminal"] === "string" ? (settings["app:externalterminal"] as string) : null
    );
}

async function openExternalTerminal(request: ExternalTerminalRequest) {
    const cwd = request?.cwd;
    const connection = request?.connection ?? "";
    if (cwd == null || cwd.trim() === "") {
        return;
    }
    if (unamePlatform === "darwin") {
        openMacTerminal(cwd, connection, await getConfiguredMacExternalTerminalApp());
        return;
    }
    if (unamePlatform === "win32") {
        await openWindowsTerminal(cwd, connection, await getConfiguredWindowsExternalTerminalApp());
        return;
    }
    const command = buildExternalTerminalCommand(connection, cwd);
    if (command == null) {
        electron.dialog.showErrorBox("打开终端失败", `暂不支持的连接类型：${connection}`);
        return;
    }
    spawnDetached("/bin/sh", [
        "-lc",
        `x-terminal-emulator -e ${shellEscapePosix(command)} || gnome-terminal -- sh -lc ${shellEscapePosix(
            command
        )} || xterm -e ${shellEscapePosix(command)}`,
    ]);
}

function listDirectoryOpenTargets(connection?: string | null): DirectoryOpenTarget[] {
    if (unamePlatform !== "darwin") {
        return ["terminal"];
    }
    const parsed = parseTerminalConnection(connection);
    const targets: DirectoryOpenTarget[] = [];
    if (parsed?.kind === "local") {
        targets.push("finder");
    }
    targets.push("terminal");
    return targets;
}

async function openDirectoryTarget(request: OpenDirectoryTargetRequest) {
    const cwd = request?.cwd;
    const connection = request?.connection ?? "";
    const target = request?.target ?? "terminal";
    if (cwd == null || cwd.trim() === "") {
        return;
    }
    if (target === "finder") {
        const parsed = parseTerminalConnection(connection);
        if (unamePlatform === "darwin" && parsed?.kind === "local") {
            spawnDetached("open", ["-a", "Finder", expandLocalHomePath(cwd)]);
            return;
        }
        electron.dialog.showErrorBox("打开失败", "Finder 只支持打开本地目录。");
        return;
    }
    await openExternalTerminal({ cwd, connection });
}

function getSingleHeaderVal(headers: Record<string, string | string[]>, key: string): string {
    const val = headers[key];
    if (val == null) {
        return null;
    }
    if (Array.isArray(val)) {
        return val[0];
    }
    return val;
}

function cleanMimeType(mimeType: string): string {
    if (mimeType == null) {
        return null;
    }
    const parts = mimeType.split(";");
    return parts[0].trim();
}

function getFileNameFromUrl(url: string): string {
    try {
        const pathname = new URL(url).pathname;
        const filename = pathname.substring(pathname.lastIndexOf("/") + 1);
        return filename;
    } catch (e) {
        return null;
    }
}

function getUrlInSession(session: Electron.Session, url: string): Promise<UrlInSessionResult> {
    return new Promise((resolve, reject) => {
        if (url.startsWith("data:")) {
            try {
                const parsed = parseDataUrl(url);
                const buffer = Buffer.from(parsed.buffer);
                const readable = Readable.from(buffer);
                resolve({ stream: readable, mimeType: parsed.mimeType, fileName: "image" });
            } catch (err) {
                return reject(err);
            }
            return;
        }
        const request = electron.net.request({
            url,
            method: "GET",
            session,
        });
        const readable = new Readable({
            read() {},
        });
        request.on("response", (response) => {
            const statusCode = response.statusCode;
            if (statusCode < 200 || statusCode >= 300) {
                readable.destroy();
                request.abort();
                reject(new Error(`HTTP request failed with status ${statusCode}: ${response.statusMessage || ""}`));
                return;
            }

            const mimeType = cleanMimeType(getSingleHeaderVal(response.headers, "content-type"));
            const fileName = getFileNameFromUrl(url) || "image";
            response.on("data", (chunk) => {
                readable.push(chunk);
            });
            response.on("end", () => {
                readable.push(null);
                resolve({ stream: readable, mimeType, fileName });
            });
            response.on("error", (err) => {
                readable.destroy(err);
                reject(err);
            });
        });
        request.on("error", (err) => {
            readable.destroy(err);
            reject(err);
        });
        request.end();
    });
}

function saveImageFileWithNativeDialog(defaultFileName: string, mimeType: string, readStream: Readable) {
    if (defaultFileName == null || defaultFileName == "") {
        defaultFileName = "image";
    }
    const ww = focusedWaveWindow;
    if (ww == null) {
        return;
    }
    const mimeToExtension: { [key: string]: string } = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "image/heic": "heic",
        "image/svg+xml": "svg",
    };
    function addExtensionIfNeeded(fileName: string, mimeType: string): string {
        const extension = mimeToExtension[mimeType];
        if (!path.extname(fileName) && extension) {
            return `${fileName}.${extension}`;
        }
        return fileName;
    }
    defaultFileName = addExtensionIfNeeded(defaultFileName, mimeType);
    electron.dialog
        .showSaveDialog(ww, {
            title: "保存图片",
            defaultPath: defaultFileName,
            filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic"] }],
        })
        .then((file) => {
            if (file.canceled) {
                return;
            }
            const writeStream = fs.createWriteStream(file.filePath);
            readStream.pipe(writeStream);
            writeStream.on("finish", () => {
                console.log("saved file", file.filePath);
            });
            writeStream.on("error", (err) => {
                console.log("error saving file (writeStream)", err);
                readStream.destroy();
            });
            readStream.on("error", (err) => {
                console.error("error saving file (readStream)", err);
                writeStream.destroy();
            });
        })
        .catch((err) => {
            console.log("error trying to save file", err);
        });
}

export function initIpcHandlers() {
    electron.ipcMain.on("open-external", (event, url) => {
        if (url && typeof url === "string") {
            fireAndForget(() =>
                callWithOriginalXdgCurrentDesktopAsync(() =>
                    electron.shell.openExternal(url).catch((err) => {
                        console.error(`Failed to open URL ${url}:`, err);
                    })
                )
            );
        } else {
            console.error("Invalid URL received in open-external event:", url);
        }
    });

    electron.ipcMain.on("download", (event, payload) => {
        const baseName = encodeURIComponent(path.basename(payload.filePath));
        const streamingUrl =
            getWebServerEndpoint() + "/wave/stream-file/" + baseName + "?path=" + encodeURIComponent(payload.filePath);
        event.sender.downloadURL(streamingUrl);
    });

    electron.ipcMain.on("get-cursor-point", (event) => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (tabView == null) {
            event.returnValue = null;
            return;
        }
        const screenPoint = electron.screen.getCursorScreenPoint();
        const windowRect = tabView.getBounds();
        const retVal: Electron.Point = {
            x: screenPoint.x - windowRect.x,
            y: screenPoint.y - windowRect.y,
        };
        event.returnValue = retVal;
    });

    electron.ipcMain.handle("capture-screenshot", async (event, rect) => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (!tabView) {
            throw new Error("No tab view found for the given webContents id");
        }
        const image = await tabView.webContents.capturePage(rect);
        const base64String = image.toPNG().toString("base64");
        return `data:image/png;base64,${base64String}`;
    });

    electron.ipcMain.on("get-env", (event, varName) => {
        event.returnValue = process.env[varName] ?? null;
    });

    electron.ipcMain.on("get-about-modal-details", (event) => {
        event.returnValue = getWaveVersion() as AboutModalDetails;
    });

    electron.ipcMain.on("get-zoom-factor", (event) => {
        event.returnValue = event.sender.getZoomFactor();
    });

    electron.ipcMain.on("set-keyboard-chord-mode", (event) => {
        event.returnValue = null;
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        tabView?.setKeyboardChordMode(true);
    });

    const fac = new FastAverageColor();
    electron.ipcMain.on("update-window-controls-overlay", async (event, rect: Dimensions) => {
        if (unamePlatform === "darwin") return;
        try {
            const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
            if (fullConfig?.settings?.["window:nativetitlebar"] && unamePlatform !== "win32") return;

            const zoomFactor = event.sender.getZoomFactor();
            const electronRect: Electron.Rectangle = {
                x: rect.left * zoomFactor,
                y: rect.top * zoomFactor,
                height: rect.height * zoomFactor,
                width: rect.width * zoomFactor,
            };
            const overlay = await event.sender.capturePage(electronRect);
            const overlayBuffer = overlay.toPNG();
            const png = PNG.sync.read(overlayBuffer);
            const color = fac.prepareResult(fac.getColorFromArray4(png.data));
            const ww = getWaveWindowByWebContentsId(event.sender.id);
            ww.setTitleBarOverlay({
                color: unamePlatform === "linux" ? color.rgba : "#00000000",
                symbolColor: color.isDark ? "white" : "black",
            });
        } catch (e) {
            console.error("Error updating window controls overlay:", e);
        }
    });

    electron.ipcMain.on("quicklook", (event, filePath: string) => {
        if (unamePlatform !== "darwin") return;
        child_process.execFile("/usr/bin/qlmanage", ["-p", filePath], (error, stdout, stderr) => {
            if (error) {
                console.error(`Error opening Quick Look: ${error}`);
            }
        });
    });

    electron.ipcMain.on("open-native-path", (event, filePath: string) => {
        console.log("open-native-path", filePath);
        filePath = filePath.replace("~", electronApp.getPath("home"));
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(() =>
                electron.shell.openPath(filePath).then((excuse) => {
                    if (excuse) console.error(`Failed to open ${filePath} in native application: ${excuse}`);
                })
            )
        );
    });

    electron.ipcMain.on("open-external-terminal", (_event, request: ExternalTerminalRequest) => {
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(async () => {
                await openExternalTerminal(request);
            })
        );
    });

    electron.ipcMain.on("open-directory-target", (_event, request: OpenDirectoryTargetRequest) => {
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(async () => {
                await openDirectoryTarget(request);
            })
        );
    });

    electron.ipcMain.handle("list-directory-open-targets", (_event, connection?: string | null) => {
        return listDirectoryOpenTargets(connection);
    });

    electron.ipcMain.handle("list-external-terminal-apps", () => {
        return listExternalTerminalApps();
    });

    electron.ipcMain.on("open-file-in-browser", (event, filePath: string) => {
        console.log("open-file-in-browser", filePath);
        filePath = filePath.replace("~", electronApp.getPath("home"));
        const fileUrl = pathToFileURL(filePath).toString();
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(() =>
                electron.shell.openExternal(fileUrl).catch((err) => {
                    console.error(`Failed to open ${filePath} in browser:`, err);
                })
            )
        );
    });

    electron.ipcMain.on("show-item-in-folder", (event, filePath: string) => {
        console.log("show-item-in-folder", filePath);
        filePath = filePath.replace("~", electronApp.getPath("home"));
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(async () => {
                electron.shell.showItemInFolder(filePath);
            })
        );
    });

    electron.ipcMain.on("set-window-init-status", (event, status: "ready" | "wave-ready") => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (tabView != null && tabView.initResolve != null) {
            if (status === "ready") {
                tabView.initResolve();
                if (tabView.savedInitOpts) {
                    console.log("savedInitOpts calling wave-init", tabView.waveTabId);
                    tabView.webContents.send("wave-init", tabView.savedInitOpts);
                }
            } else if (status === "wave-ready") {
                tabView.waveReadyResolve();
            }
            return;
        }

        console.log("set-window-init-status: no window found for webContentsId", event.sender.id);
    });

    electron.ipcMain.on("fe-log", (event, logStr: string) => {
        console.log("fe-log", logStr);
    });

    electron.ipcMain.on("increment-term-commands", () => {
        incrementTermCommandsRun();
    });

    electron.ipcMain.on("native-paste", (event) => {
        event.sender.paste();
    });

    electron.ipcMain.on("open-new-window", () => fireAndForget(createNewWaveWindow));
    electron.ipcMain.on("open-file-in-new-tab", (event, request: FileWindowOpenRequest) =>
        fireAndForget(() => openFileInNewTab(event.sender.id, request))
    );

    electron.ipcMain.on("do-refresh", (event) => {
        event.sender.reloadIgnoringCache();
    });

    electron.ipcMain.handle("write-clipboard-text", (_event, text: string) => {
        electron.clipboard.writeText(text ?? "");
    });

    electron.ipcMain.handle("write-clipboard-html", (_event, payload: { html?: string; text?: string } | null) => {
        const html = payload?.html ?? "";
        const text = payload?.text ?? "";
        electron.clipboard.write({
            html,
            text,
        });
    });

    electron.ipcMain.handle("read-clipboard-files", () => {
        // macOS: read file paths from pasteboard
        if (unamePlatform === "darwin") {
            try {
                const result = child_process.execFileSync("/usr/bin/osascript", [
                    "-e",
                    'set theFiles to {}\n' +
                    'try\n' +
                    '  set theClip to the clipboard as «class furl»\n' +
                    '  set end of theFiles to POSIX path of theClip\n' +
                    'on error\n' +
                    '  try\n' +
                    '    set theClips to the clipboard as list of «class furl»\n' +
                    '    repeat with f in theClips\n' +
                    '      set end of theFiles to POSIX path of f\n' +
                    '    end repeat\n' +
                    '  end try\n' +
                    'end try\n' +
                    'set AppleScript\'s text item delimiters to "\\n"\n' +
                    'return theFiles as text',
                ], { encoding: "utf-8", timeout: 3000 });
                const paths = result.trim().split("\n").filter((p) => p.length > 0);
                return paths;
            } catch (e) {
                return [];
            }
        }
        return [];
    });

    electron.ipcMain.handle("read-clipboard-image", () => {
        try {
            const image = electron.clipboard.readImage();
            if (!image || image.isEmpty()) {
                return null;
            }
            return {
                mimeType: "image/png",
                data64: image.toPNG().toString("base64"),
            };
        } catch (e) {
            return null;
        }
    });
}
