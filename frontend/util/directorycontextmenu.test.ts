import { assert, test } from "vitest";
import {
    buildDirectoryBackgroundMenuEntries,
    buildDirectoryItemMenuEntries,
    resolveDirectoryContextSelection,
} from "./directorycontextmenu";
import { PlatformMacOS, setPlatform } from "./platformutil";

function getMenuLabels(menu: { label?: string; type?: string }[]): string[] {
    return menu.map((item) => item.label ?? item.type ?? "");
}

test("file item menu excludes background actions and keeps file actions focused", () => {
    setPlatform(PlatformMacOS);
    const menu = buildDirectoryItemMenuEntries({
        conn: "",
        finfo: {
            path: "/tmp/demo.txt",
            dir: "/tmp",
            name: "demo.txt",
            isdir: false,
        } as FileInfo,
        locale: "zh-CN",
        relativePath: "demo.txt",
    });

    assert.deepEqual(getMenuLabels(menu), [
        "在当前标签页打开",
        "在新标签页打开",
        "在此处打开终端",
        "separator",
        "在 Finder 中显示",
        "用默认应用打开",
        "separator",
        "重命名",
        "复制",
        "剪切",
        "删除",
        "separator",
        "复制文件名",
        "复制完整路径",
        "复制相对路径",
    ]);
});

test("html file item menu includes browser action", () => {
    setPlatform(PlatformMacOS);
    const menu = buildDirectoryItemMenuEntries({
        conn: "",
        finfo: {
            path: "/tmp/demo.html",
            dir: "/tmp",
            name: "demo.html",
            isdir: false,
        } as FileInfo,
        locale: "zh-CN",
        relativePath: "demo.html",
    });

    assert.deepEqual(getMenuLabels(menu), [
        "在当前标签页打开",
        "在新标签页打开",
        "在此处打开终端",
        "separator",
        "在 Finder 中显示",
        "在默认浏览器中打开",
        "用默认应用打开",
        "separator",
        "重命名",
        "复制",
        "剪切",
        "删除",
        "separator",
        "复制文件名",
        "复制完整路径",
        "复制相对路径",
    ]);
});

test("directory item menu keeps navigation separate from directory-level creation", () => {
    setPlatform(PlatformMacOS);
    const menu = buildDirectoryItemMenuEntries({
        conn: "",
        finfo: {
            path: "/tmp/demo",
            dir: "/tmp",
            name: "demo",
            isdir: true,
        } as FileInfo,
        locale: "zh-CN",
        relativePath: "demo",
    });

    assert.deepEqual(getMenuLabels(menu), [
        "当前窗口跳转",
        "在当前标签页打开",
        "在新标签页打开",
        "separator",
        "添加到书签",
        "separator",
        "在 Finder 中打开",
        "separator",
        "在此处打开终端",
        "separator",
        "重命名",
        "复制",
        "剪切",
        "删除",
        "separator",
        "复制文件名",
        "复制完整路径",
        "复制相对路径",
    ]);
});

test("background menu only exposes directory-scoped actions", () => {
    setPlatform(PlatformMacOS);
    const menu = buildDirectoryBackgroundMenuEntries({
        conn: "",
        finfo: {
            path: "/tmp/demo",
            dir: "/tmp",
            name: "demo",
            isdir: true,
        } as FileInfo,
        locale: "zh-CN",
        clipboardCount: 2,
    });

    assert.deepEqual(getMenuLabels(menu), [
        "新建文件",
        "新建文件夹",
        "粘贴（2 项）",
        "separator",
        "在 Finder 中打开",
        "separator",
        "在此处打开终端",
    ]);
});

test("right-clicking an unselected item switches copy actions to that item", () => {
    const selection = resolveDirectoryContextSelection(
        new Set(["/tmp/a.txt", "/tmp/b.txt"]),
        {
            path: "/tmp/c.txt",
            dir: "/tmp",
            name: "c.txt",
            isdir: false,
        } as FileInfo
    );

    assert.deepEqual(selection, {
        nextSelectedPaths: ["/tmp/c.txt"],
        actionPaths: ["/tmp/c.txt"],
    });
});

test("right-clicking inside an existing multi-selection keeps the selection", () => {
    const selection = resolveDirectoryContextSelection(
        new Set(["/tmp/a.txt", "/tmp/b.txt"]),
        {
            path: "/tmp/b.txt",
            dir: "/tmp",
            name: "b.txt",
            isdir: false,
        } as FileInfo
    );

    assert.deepEqual(selection, {
        nextSelectedPaths: ["/tmp/a.txt", "/tmp/b.txt"],
        actionPaths: ["/tmp/a.txt", "/tmp/b.txt"],
    });
});
