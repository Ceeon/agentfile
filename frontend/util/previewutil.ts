import { createBlock, createBlockAtRightmost, getApi } from "@/app/store/global";
import { getNativeManagerName, makeNativeLabel, type NativeLabelLocale } from "./platformutil";
import { fireAndForget } from "./util";
import { formatRemoteUri } from "./waveutil";

type AddOpenMenuItemsOptions = {
    locale?: NativeLabelLocale;
};

export type MenuEntry<ActionId extends string> =
    | { type: "separator" }
    | { type: "action"; id: ActionId; label: string };

export type OpenMenuActionId =
    | "open-native-directory"
    | "reveal-native-file"
    | "open-in-browser"
    | "open-default-app"
    | "download-file"
    | "open-preview-block"
    | "open-new-tab"
    | "open-terminal";

export type OpenMenuEntry = MenuEntry<OpenMenuActionId>;

function getLocalizedLabel(locale: NativeLabelLocale, zhCN: string, en: string) {
    return locale === "zh-CN" ? zhCN : en;
}

function getDirectoryManagerLabel(locale: NativeLabelLocale) {
    const managerName = getNativeManagerName(locale);
    return getLocalizedLabel(locale, `在 ${managerName} 中打开`, `Open in ${managerName}`);
}

function getFileRevealLabel(locale: NativeLabelLocale) {
    const managerName = getNativeManagerName(locale);
    return getLocalizedLabel(locale, `在 ${managerName} 中显示`, `Reveal in ${managerName}`);
}

function getDefaultAppLabel(locale: NativeLabelLocale) {
    return locale === "zh-CN" ? "用默认应用打开" : makeNativeLabel(false, locale);
}

function getBrowserLabel(locale: NativeLabelLocale) {
    return getLocalizedLabel(locale, "在默认浏览器中打开", "Open in Default Browser");
}

function isHtmlLikeFile(finfo: FileInfo): boolean {
    const mimeType = finfo?.mimetype?.toLowerCase()?.split(";")[0]?.trim();
    if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
        return true;
    }
    const fileName = (finfo?.name ?? finfo?.path ?? "").toLowerCase();
    return fileName.endsWith(".html") || fileName.endsWith(".htm") || fileName.endsWith(".xhtml");
}

export function buildOpenMenuEntries(
    conn: string,
    finfo: FileInfo,
    options: AddOpenMenuItemsOptions = {}
): OpenMenuEntry[] {
    if (!finfo) {
        return [];
    }
    const locale = options.locale ?? "zh-CN";
    const menu: OpenMenuEntry[] = [];
    const primaryActions: OpenMenuEntry[] = [];
    const secondaryActions: OpenMenuEntry[] = [];

    if (!finfo.isdir) {
        primaryActions.push({
            type: "action",
            id: "open-preview-block",
            label: getLocalizedLabel(locale, "在当前标签页打开", "Open in Current Tab"),
        });
        primaryActions.push({
            type: "action",
            id: "open-new-tab",
            label: getLocalizedLabel(locale, "在新标签页打开", "Open in New Tab"),
        });
    }
    primaryActions.push({
        type: "action",
        id: "open-terminal",
        label: getLocalizedLabel(locale, "在此处打开终端", "Open Terminal Here"),
    });

    if (!conn) {
        if (finfo.isdir) {
            secondaryActions.push({
                type: "action",
                id: "open-native-directory",
                label: getDirectoryManagerLabel(locale),
            });
        } else {
            secondaryActions.push({
                type: "action",
                id: "reveal-native-file",
                label: getFileRevealLabel(locale),
            });
            if (isHtmlLikeFile(finfo)) {
                secondaryActions.push({
                    type: "action",
                    id: "open-in-browser",
                    label: getBrowserLabel(locale),
                });
            }
            secondaryActions.push({
                type: "action",
                id: "open-default-app",
                label: getDefaultAppLabel(locale),
            });
        }
    } else if (!finfo.isdir) {
        secondaryActions.push({
            type: "action",
            id: "download-file",
            label: getLocalizedLabel(locale, "下载文件", "Download File"),
        });
    }

    const preferSecondaryFirst = !!finfo.isdir;
    const firstSection = preferSecondaryFirst ? secondaryActions : primaryActions;
    const secondSection = preferSecondaryFirst ? primaryActions : secondaryActions;

    menu.push(...firstSection);
    if (firstSection.length > 0 && secondSection.length > 0) {
        menu.push({ type: "separator" });
    }
    menu.push(...secondSection);
    return menu;
}

export function getOpenMenuActionHandler(id: OpenMenuActionId, conn: string, finfo: FileInfo): () => void {
    switch (id) {
        case "open-native-directory":
            return () => {
                getApi().openNativePath(finfo.path);
            };
        case "reveal-native-file":
            return () => {
                getApi().showItemInFolder(finfo.path);
            };
        case "open-in-browser":
            return () => {
                getApi().openFileInBrowser(finfo.path);
            };
        case "open-default-app":
            return () => {
                getApi().openNativePath(finfo.path);
            };
        case "download-file":
            return () => {
                const remoteUri = formatRemoteUri(finfo.path, conn);
                getApi().downloadFile(remoteUri);
            };
        case "open-preview-block":
            return () =>
                fireAndForget(async () => {
                    const blockDef: BlockDef = {
                        meta: {
                            view: "preview",
                            file: finfo.path,
                            connection: conn,
                        },
                    };
                    await createBlockAtRightmost(blockDef);
                });
        case "open-new-tab":
            return () => {
                getApi().openFileInNewTab(finfo.path, conn);
            };
        case "open-terminal":
            return () => {
                getApi().openExternalTerminal(finfo.isdir ? finfo.path : finfo.dir, conn);
            };
    }
}

export function buildOpenMenuItems(
    conn: string,
    finfo: FileInfo,
    options: AddOpenMenuItemsOptions = {}
): ContextMenuItem[] {
    return buildOpenMenuEntries(conn, finfo, options).map((entry) => {
        if (entry.type === "separator") {
            return { type: "separator" };
        }
        return {
            label: entry.label,
            click: getOpenMenuActionHandler(entry.id, conn, finfo),
        };
    });
}

export function normalizeMenuSeparators(menu: ContextMenuItem[]): ContextMenuItem[] {
    const normalized: ContextMenuItem[] = [];
    for (const item of menu) {
        if (item.type === "separator") {
            if (normalized.length === 0 || normalized[normalized.length - 1]?.type === "separator") {
                continue;
            }
        }
        normalized.push(item);
    }
    while (normalized.length > 0 && normalized[normalized.length - 1]?.type === "separator") {
        normalized.pop();
    }
    return normalized;
}

export function addOpenMenuItems(
    menu: ContextMenuItem[],
    conn: string,
    finfo: FileInfo,
    options: AddOpenMenuItemsOptions = {}
): ContextMenuItem[] {
    const openMenuItems = buildOpenMenuItems(conn, finfo, options);
    if (openMenuItems.length === 0) {
        return menu;
    }
    if (menu.length > 0 && menu[menu.length - 1]?.type !== "separator") {
        menu.push({ type: "separator" });
    }
    menu.push(...openMenuItems);
    return menu;
}
