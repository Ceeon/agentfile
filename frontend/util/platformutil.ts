// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export const PlatformMacOS = "darwin";
export const PlatformWindows = "win32";
export let PLATFORM: NodeJS.Platform = PlatformMacOS;
export type NativeLabelLocale = "en" | "zh-CN";

export function setPlatform(platform: NodeJS.Platform) {
    PLATFORM = platform;
}

export function isMacOS(): boolean {
    return PLATFORM == PlatformMacOS;
}

export function isWindows(): boolean {
    return PLATFORM == PlatformWindows;
}

export function getNativeManagerName(locale: NativeLabelLocale = "zh-CN") {
    if (PLATFORM === PlatformMacOS) {
        return "Finder";
    }
    if (PLATFORM == PlatformWindows) {
        return locale === "zh-CN" ? "资源管理器" : "Explorer";
    }
    return locale === "zh-CN" ? "文件管理器" : "File Manager";
}

export function makeNativeLabel(isDirectory: boolean, locale: NativeLabelLocale = "zh-CN") {
    if (locale === "zh-CN") {
        if (isDirectory) {
            return `在${getNativeManagerName(locale)}中显示`;
        }
        return "用默认应用打开";
    }

    let managerName: string;
    if (!isDirectory) {
        managerName = "Default Application";
    } else {
        managerName = getNativeManagerName(locale);
    }

    let fileAction: string;
    if (isDirectory) {
        fileAction = "Reveal";
    } else {
        fileAction = "Open File";
    }
    return `${fileAction} in ${managerName}`;
}
