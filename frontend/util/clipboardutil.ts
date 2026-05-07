// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type ClipboardPayload = { text?: string; image?: Blob };

export const MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/tiff": "tiff",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/avif": "avif",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
};

async function extractClipboardData(item: ClipboardItem): Promise<ClipboardPayload | null> {
    const imageTypes = item.types.filter((type) => type.startsWith("image/"));
    if (imageTypes.length > 0) {
        const blob = await item.getType(imageTypes[0]);
        return { image: blob };
    }

    const plainTextType = item.types.find((type) => type === "text" || type === "text/plain" || type.startsWith("text/plain;"));
    if (plainTextType) {
        const blob = await item.getType(plainTextType);
        const text = await blob.text();
        return text ? { text } : null;
    }

    const htmlType = item.types.find((type) => type === "text/html" || type.startsWith("text/html;"));
    if (htmlType) {
        const blob = await item.getType(htmlType);
        const html = await blob.text();
        if (!html) {
            return null;
        }
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        const text = tempDiv.textContent || "";
        return text ? { text } : null;
    }

    const genericType = item.types.find((type) => type === "");
    if (genericType != null) {
        const blob = await item.getType(genericType);
        const text = await blob.text();
        return text ? { text } : null;
    }

    return null;
}

function findFirstDataTransferItem(
    items: DataTransferItemList,
    kind: string,
    typePredicate: (type: string) => boolean
): DataTransferItem | null {
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item.kind === kind && typePredicate(item.type)) {
            return item;
        }
    }
    return null;
}

function findAllDataTransferItems(
    items: DataTransferItemList,
    kind: string,
    typePredicate: (type: string) => boolean
): DataTransferItem[] {
    const results: DataTransferItem[] = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item.kind === kind && typePredicate(item.type)) {
            results.push(item);
        }
    }
    return results;
}

async function extractDataTransferItems(items: DataTransferItemList): Promise<ClipboardPayload[]> {
    const imageFiles = findAllDataTransferItems(items, "file", (type) => type.startsWith("image/"));
    if (imageFiles.length > 0) {
        return imageFiles
            .map((item) => item.getAsFile())
            .filter((blob): blob is File => blob != null)
            .map((blob) => ({ image: blob }));
    }

    const plainTextItem = findFirstDataTransferItem(
        items,
        "string",
        (type) => type === "text" || type === "text/plain" || type.startsWith("text/plain;")
    );
    if (plainTextItem) {
        return new Promise((resolve) => {
            plainTextItem.getAsString((text) => {
                resolve(text ? [{ text }] : []);
            });
        });
    }

    const htmlItem = findFirstDataTransferItem(
        items,
        "string",
        (type) => type === "text/html" || type.startsWith("text/html;")
    );
    if (htmlItem) {
        return new Promise((resolve) => {
            htmlItem.getAsString((html) => {
                if (!html) {
                    resolve([]);
                    return;
                }
                const tempDiv = document.createElement("div");
                tempDiv.innerHTML = html;
                const text = tempDiv.textContent || "";
                resolve(text ? [{ text }] : []);
            });
        });
    }

    const genericStringItem = findFirstDataTransferItem(items, "string", (type) => type === "" || type == null);
    if (genericStringItem) {
        return new Promise((resolve) => {
            genericStringItem.getAsString((text) => {
                resolve(text ? [{ text }] : []);
            });
        });
    }

    return [];
}

export async function extractAllClipboardData(event?: ClipboardEvent): Promise<ClipboardPayload[]> {
    try {
        if (event?.clipboardData?.items) {
            return await extractDataTransferItems(event.clipboardData.items);
        }

        const clipboardItems = await navigator.clipboard.read();
        const results: ClipboardPayload[] = [];
        for (const item of clipboardItems) {
            const data = await extractClipboardData(item);
            if (data) {
                results.push(data);
            }
        }
        return results;
    } catch (error) {
        console.error("Clipboard read error:", error);
        const text = event?.clipboardData?.getData("text/plain");
        return text ? [{ text }] : [];
    }
}
