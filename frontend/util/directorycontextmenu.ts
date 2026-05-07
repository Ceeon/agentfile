import { type NativeLabelLocale } from "./platformutil";
import { buildOpenMenuEntries, type MenuEntry, type OpenMenuActionId } from "./previewutil";

export type DirectoryContextMenuActionId =
    | OpenMenuActionId
    | "open-wave-directory"
    | "open-new-tab"
    | "bookmark"
    | "new-file"
    | "new-folder"
    | "paste"
    | "rename"
    | "copy"
    | "cut"
    | "copy-name"
    | "copy-path"
    | "copy-relative-path"
    | "delete";

export type DirectoryContextMenuEntry = MenuEntry<DirectoryContextMenuActionId>;
export type DirectoryContextSelectionResult = {
    nextSelectedPaths: string[];
    actionPaths: string[];
};

type DirectoryContextMenuOptions = {
    conn: string;
    finfo: FileInfo;
    locale?: NativeLabelLocale;
    relativePath?: string | null;
    clipboardCount?: number;
};

function pasteLabel(count?: number) {
    return count && count > 0 ? `粘贴（${count} 项）` : "粘贴";
}

function pushSection(menu: DirectoryContextMenuEntry[], section: DirectoryContextMenuEntry[]) {
    if (section.length === 0) {
        return;
    }
    if (menu.length > 0) {
        menu.push({ type: "separator" });
    }
    menu.push(...section);
}

function buildCopyInfoEntries(relativePath?: string | null): DirectoryContextMenuEntry[] {
    const menu: DirectoryContextMenuEntry[] = [
        { type: "action", id: "copy-name", label: "复制文件名" },
        { type: "action", id: "copy-path", label: "复制完整路径" },
    ];
    if (relativePath) {
        menu.push({ type: "action", id: "copy-relative-path", label: "复制相对路径" });
    }
    return menu;
}

export function resolveDirectoryContextSelection(
    selectedPaths: Iterable<string>,
    finfo: FileInfo
): DirectoryContextSelectionResult {
    if (!finfo || finfo.name === "..") {
        return { nextSelectedPaths: [], actionPaths: [] };
    }

    const currentSelectedPaths = Array.from(selectedPaths);
    if (currentSelectedPaths.includes(finfo.path)) {
        return {
            nextSelectedPaths: currentSelectedPaths,
            actionPaths: currentSelectedPaths,
        };
    }

    return {
        nextSelectedPaths: [finfo.path],
        actionPaths: [finfo.path],
    };
}

export function buildDirectoryItemMenuEntries(options: DirectoryContextMenuOptions): DirectoryContextMenuEntry[] {
    const { conn, finfo, locale = "zh-CN", relativePath } = options;
    const menu: DirectoryContextMenuEntry[] = [];
    const isParentEntry = finfo.name === "..";

    if (finfo.isdir) {
        const directorySection: DirectoryContextMenuEntry[] = [
            {
                type: "action",
                id: "open-wave-directory",
                label: isParentEntry ? "进入上级目录" : "当前窗口跳转",
            },
        ];
        if (!isParentEntry) {
            directorySection.push({
                type: "action",
                id: "open-preview-block",
                label: "在当前标签页打开",
            });
            directorySection.push({
                type: "action",
                id: "open-new-tab",
                label: "在新标签页打开",
            });
            directorySection.push({ type: "separator" });
            directorySection.push({
                type: "action",
                id: "bookmark",
                label: "添加到书签",
            });
        }
        pushSection(menu, directorySection);
    }

    pushSection(menu, buildOpenMenuEntries(conn, finfo, { locale }));

    if (!isParentEntry) {
        pushSection(menu, [
            { type: "action", id: "rename", label: "重命名" },
            { type: "action", id: "copy", label: "复制" },
            { type: "action", id: "cut", label: "剪切" },
            { type: "action", id: "delete", label: "删除" },
        ]);
    }

    pushSection(menu, buildCopyInfoEntries(relativePath));
    return menu;
}

export function buildDirectoryBackgroundMenuEntries(
    options: DirectoryContextMenuOptions
): DirectoryContextMenuEntry[] {
    const { conn, finfo, locale = "zh-CN", clipboardCount } = options;
    const menu: DirectoryContextMenuEntry[] = [
        { type: "action", id: "new-file", label: "新建文件" },
        { type: "action", id: "new-folder", label: "新建文件夹" },
        { type: "action", id: "paste", label: pasteLabel(clipboardCount) },
    ];

    pushSection(menu, buildOpenMenuEntries(conn, finfo, { locale }));
    return menu;
}
