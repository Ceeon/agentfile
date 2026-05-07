// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { assert, test } from "vitest";
import { PlatformMacOS, setPlatform } from "./platformutil";
import { buildOpenMenuItems, normalizeMenuSeparators } from "./previewutil";

function getMenuLabels(menu: ContextMenuItem[]): string[] {
    return menu.map((item) => item.label ?? item.type ?? "");
}

test("buildOpenMenuItems local file uses Chinese Finder labels without duplicates", () => {
    setPlatform(PlatformMacOS);
    const menu = buildOpenMenuItems(
        "",
        {
            path: "/tmp/demo.txt",
            dir: "/tmp",
            name: "demo.txt",
            isdir: false,
        } as FileInfo,
        { locale: "zh-CN" }
    );

    assert.deepEqual(getMenuLabels(menu), [
        "在当前标签页打开",
        "在新标签页打开",
        "在此处打开终端",
        "separator",
        "在 Finder 中显示",
        "用默认应用打开",
    ]);
});

test("buildOpenMenuItems local html file adds browser action", () => {
    setPlatform(PlatformMacOS);
    const menu = buildOpenMenuItems(
        "",
        {
            path: "/tmp/demo.html",
            dir: "/tmp",
            name: "demo.html",
            isdir: false,
        } as FileInfo,
        { locale: "zh-CN" }
    );

    assert.deepEqual(getMenuLabels(menu), [
        "在当前标签页打开",
        "在新标签页打开",
        "在此处打开终端",
        "separator",
        "在 Finder 中显示",
        "在默认浏览器中打开",
        "用默认应用打开",
    ]);
});

test("buildOpenMenuItems local directory opens Finder directly", () => {
    setPlatform(PlatformMacOS);
    const menu = buildOpenMenuItems(
        "",
        {
            path: "/tmp/demo",
            dir: "/tmp",
            name: "demo",
            isdir: true,
        } as FileInfo,
        { locale: "zh-CN" }
    );

    assert.deepEqual(getMenuLabels(menu), ["在 Finder 中打开", "separator", "在此处打开终端"]);
});

test("buildOpenMenuItems remote file keeps Chinese remote actions", () => {
    setPlatform(PlatformMacOS);
    const menu = buildOpenMenuItems(
        "prod",
        {
            path: "/var/log/demo.log",
            dir: "/var/log",
            name: "demo.log",
            isdir: false,
        } as FileInfo,
        { locale: "zh-CN" }
    );

    assert.deepEqual(getMenuLabels(menu), ["在当前标签页打开", "在新标签页打开", "在此处打开终端", "separator", "下载文件"]);
});

test("buildOpenMenuItems remote directory skips invalid download action", () => {
    setPlatform(PlatformMacOS);
    const menu = buildOpenMenuItems(
        "prod",
        {
            path: "/var/log",
            dir: "/var",
            name: "log",
            isdir: true,
        } as FileInfo,
        { locale: "zh-CN" }
    );

    assert.deepEqual(getMenuLabels(menu), ["在此处打开终端"]);
});

test("normalizeMenuSeparators removes duplicate edge separators", () => {
    const normalized = normalizeMenuSeparators([
        { type: "separator" },
        { type: "separator" },
        { label: "A" },
        { type: "separator" },
        { type: "separator" },
        { label: "B" },
        { type: "separator" },
    ]);

    assert.deepEqual(getMenuLabels(normalized), ["A", "separator", "B"]);
});
