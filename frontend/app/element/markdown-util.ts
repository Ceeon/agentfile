// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getWebServerEndpoint } from "@/util/endpoints";
import { base64ToString } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import parseSrcSet from "parse-srcset";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type MarkdownContentBlockType = {
    type: string;
    id: string;
    content: string;
    opts?: Record<string, any>;
};

const idMatchRe = /^("(?:[^"\\]|\\.)*")/;
const MarkdownFileSearchLimit = 20000;
const obsidianVaultConfigCache = new Map<string, Promise<ObsidianVaultConfig | null>>();
const obsidianVaultFileMapCache = new Map<string, Promise<Map<string, string>>>();
const markdownRenderProfileCache = new Map<string, Promise<MarkdownRenderProfile>>();

const ObsidianAppleStylePluginDefs = [
    {
        manifestPath: ".obsidian/plugins/obsidian-apple-style/manifest.json",
        dataPath: ".obsidian/plugins/obsidian-apple-style/data.json",
    },
    {
        manifestPath: ".obsidian/plugins/apple-style-formatter/manifest.json",
        dataPath: ".obsidian/plugins/apple-style-formatter/data.json",
    },
] as const;

export type AppleStyleFontSize = "small" | "medium" | "large";

export type AppleStyleSettings = {
    fontSize: AppleStyleFontSize;
    autoUploadImages: boolean;
};

export const DefaultAppleStyleSettings: AppleStyleSettings = {
    fontSize: "medium",
    autoUploadImages: false,
};

type ObsidianVaultConfig = {
    vaultRoot: string;
    attachmentFolderPath?: string;
};

export type MarkdownRenderProfile = {
    appleStyle: boolean;
    appleStyleSettings: AppleStyleSettings;
};

export type MarkdownFrontmatter = Record<string, unknown>;

export type MarkdownFrontmatterParseResult = {
    data: MarkdownFrontmatter | null;
    raw: string | null;
    body: string;
};

function formatInlineContentBlock(block: MarkdownContentBlockType): string {
    return `!!!${block.type}[${block.id}]!!!`;
}

function parseOptions(str: string): Record<string, any> {
    const trimmed = str.trim();
    if (!trimmed) return null;

    try {
        const parsed = JSON.parse(trimmed);
        // Ensure it's an object (not array or primitive)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function makeMarkdownWaveBlockKey(block: MarkdownContentBlockType): string {
    return `${block.type}[${block.id}]`;
}

function looksLikeImagePath(path: string): boolean {
    return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path);
}

export function transformBlocks(content: string): { content: string; blocks: Map<string, MarkdownContentBlockType> } {
    const lines = content.split("\n");
    const blocks = new Map();
    let currentBlock = null;
    let currentContent = [];
    let processedLines = [];

    for (const line of lines) {
        // Check for start marker
        if (line.startsWith("@@@start ")) {
            // Already in a block? Add as content
            if (currentBlock) {
                processedLines.push(line);
                continue;
            }

            // Parse the start line
            const [, type, rest] = line.slice(9).match(/^(\w+)\s+(.*)/) || [];
            if (!type || !rest) {
                // Invalid format - treat as regular content
                processedLines.push(line);
                continue;
            }

            // Get the ID (everything between first set of quotes)
            const idMatch = rest.match(idMatchRe);
            if (!idMatch) {
                processedLines.push(line);
                continue;
            }

            // Parse options if any exist after the ID
            const afterId = rest.slice(idMatch[0].length).trim();
            const opts = parseOptions(afterId);

            currentBlock = {
                type,
                id: idMatch[1],
                opts,
            };
            continue;
        }

        // Check for end marker
        if (line.startsWith("@@@end ")) {
            // If we're not in a block, treat as content
            if (!currentBlock) {
                processedLines.push(line);
                continue;
            }

            // Parse the end line
            const [, type, rest] = line.slice(7).match(/^(\w+)\s+(.*)/) || [];
            if (!type || !rest) {
                currentContent.push(line);
                continue;
            }

            // Get the ID
            const idMatch = rest.match(idMatchRe);
            if (!idMatch) {
                currentContent.push(line);
                continue;
            }

            const endId = idMatch[1];

            // If this doesn't match our current block, treat as content
            if (type !== currentBlock.type || endId !== currentBlock.id) {
                currentContent.push(line);
                continue;
            }

            // Found matching end - store block and add placeholder
            const key = makeMarkdownWaveBlockKey(currentBlock);
            blocks.set(key, {
                type: currentBlock.type,
                id: currentBlock.id,
                opts: currentBlock.opts,
                content: currentContent.join("\n"),
            });

            processedLines.push(formatInlineContentBlock(currentBlock));
            currentBlock = null;
            currentContent = [];
            continue;
        }

        // Regular line - add to current block or processed lines
        if (currentBlock) {
            currentContent.push(line);
        } else {
            processedLines.push(line);
        }
    }

    // Handle unclosed block - add what we have so far
    if (currentBlock) {
        const key = makeMarkdownWaveBlockKey(currentBlock);
        blocks.set(key, {
            type: currentBlock.type,
            id: currentBlock.id,
            opts: currentBlock.opts,
            content: currentContent.join("\n"),
        });
        processedLines.push(formatInlineContentBlock(currentBlock));
    }

    return {
        content: processedLines.join("\n"),
        blocks: blocks,
    };
}

function normalizePathSeparators(path: string): string {
    return path.replace(/\\/g, "/");
}

function hasPathSeparator(path: string): boolean {
    return /[\\/]/.test(path);
}

function getBaseName(path: string): string {
    const normalizedPath = normalizePathSeparators(path);
    const lastSlashIdx = normalizedPath.lastIndexOf("/");
    if (lastSlashIdx < 0) {
        return normalizedPath;
    }
    return normalizedPath.slice(lastSlashIdx + 1);
}

function getDirName(path: string): string {
    let normalizedPath = normalizePathSeparators(path);
    if (normalizedPath.length > 1) {
        normalizedPath = normalizedPath.replace(/\/+$/, "");
    }
    if (normalizedPath === "/" || /^[A-Za-z]:\/?$/.test(normalizedPath)) {
        return normalizedPath.endsWith("/") || normalizedPath === "/" ? normalizedPath : normalizedPath + "/";
    }
    const lastSlashIdx = normalizedPath.lastIndexOf("/");
    if (lastSlashIdx < 0) {
        return normalizedPath;
    }
    if (lastSlashIdx === 0) {
        return "/";
    }
    return normalizedPath.slice(0, lastSlashIdx);
}

function getAncestorDirs(path: string): string[] {
    const ancestors: string[] = [];
    let currentPath = normalizePathSeparators(path);
    if (currentPath.length > 1) {
        currentPath = currentPath.replace(/\/+$/, "");
    }
    while (currentPath) {
        ancestors.push(currentPath);
        const parentPath = getDirName(currentPath);
        if (parentPath === currentPath) {
            break;
        }
        currentPath = parentPath;
    }
    return ancestors;
}

function makeStreamFileUrl(path: string, connName: string): string {
    const remoteUri = formatRemoteUri(path, connName);
    const usp = new URLSearchParams();
    usp.set("path", remoteUri);
    return getWebServerEndpoint() + "/wave/stream-file?" + usp.toString();
}

async function joinFile(baseDir: string, filePath: string, resolveOpts: MarkdownResolveOpts): Promise<FileInfo | null> {
    const baseDirUri = formatRemoteUri(baseDir, resolveOpts.connName);
    const fileInfo = await RpcApi.FileJoinCommand(TabRpcClient, [baseDirUri, filePath]);
    if (fileInfo == null || fileInfo.notfound) {
        return null;
    }
    return fileInfo;
}

async function readTextFile(path: string, resolveOpts: MarkdownResolveOpts): Promise<string | null> {
    const remoteUri = formatRemoteUri(path, resolveOpts.connName);
    const fileData = await RpcApi.FileReadCommand(TabRpcClient, {
        info: {
            path: remoteUri,
        },
    });
    return base64ToString(fileData?.data64) ?? null;
}

async function findObsidianVaultConfig(resolveOpts: MarkdownResolveOpts): Promise<ObsidianVaultConfig | null> {
    const cacheKey = `${resolveOpts.connName}::${normalizePathSeparators(resolveOpts.baseDir)}`;
    if (!obsidianVaultConfigCache.has(cacheKey)) {
        obsidianVaultConfigCache.set(
            cacheKey,
            (async () => {
                for (const dir of getAncestorDirs(resolveOpts.baseDir)) {
                    const appJsonInfo = await joinFile(dir, ".obsidian/app.json", resolveOpts);
                    if (appJsonInfo == null) {
                        continue;
                    }
                    const appJsonText = await readTextFile(appJsonInfo.path, resolveOpts);
                    let attachmentFolderPath: string = null;
                    if (appJsonText) {
                        try {
                            attachmentFolderPath = JSON.parse(appJsonText)?.attachmentFolderPath ?? null;
                        } catch {
                            attachmentFolderPath = null;
                        }
                    }
                    return {
                        vaultRoot: dir,
                        attachmentFolderPath,
                    };
                }
                return null;
            })()
        );
    }
    return obsidianVaultConfigCache.get(cacheKey);
}

async function getObsidianVaultFileMap(
    vaultConfig: ObsidianVaultConfig,
    resolveOpts: MarkdownResolveOpts
): Promise<Map<string, string>> {
    const cacheKey = `${resolveOpts.connName}::${normalizePathSeparators(vaultConfig.vaultRoot)}`;
    if (!obsidianVaultFileMapCache.has(cacheKey)) {
        obsidianVaultFileMapCache.set(
            cacheKey,
            (async () => {
                const fileMap = new Map<string, string>();
                const vaultRootUri = formatRemoteUri(vaultConfig.vaultRoot, resolveOpts.connName);
                const fileListStream = RpcApi.FileListStreamCommand(TabRpcClient, {
                    path: vaultRootUri,
                    opts: {
                        all: true,
                        limit: MarkdownFileSearchLimit,
                    },
                });
                for await (const chunk of fileListStream) {
                    for (const fileInfo of chunk?.fileinfo ?? []) {
                        const baseName = getBaseName(fileInfo.path ?? fileInfo.name ?? "");
                        if (!baseName || fileMap.has(baseName)) {
                            continue;
                        }
                        fileMap.set(baseName, fileInfo.path);
                    }
                }
                return fileMap;
            })()
        );
    }
    return obsidianVaultFileMapCache.get(cacheKey);
}

async function resolveObsidianFile(normalizedFilepath: string, resolveOpts: MarkdownResolveOpts): Promise<string | null> {
    const fileInfo = await resolveObsidianFileInfo(normalizedFilepath, resolveOpts);
    if (fileInfo == null) {
        return null;
    }
    return makeStreamFileUrl(fileInfo.path, resolveOpts.connName);
}

async function resolveObsidianFileInfo(
    normalizedFilepath: string,
    resolveOpts: MarkdownResolveOpts
): Promise<FileInfo | null> {
    const vaultConfig = await findObsidianVaultConfig(resolveOpts);
    if (vaultConfig == null) {
        return null;
    }
    const baseName = getBaseName(normalizedFilepath);
    if (vaultConfig.attachmentFolderPath && baseName) {
        const attachmentFile = await joinFile(
            vaultConfig.vaultRoot,
            `${vaultConfig.attachmentFolderPath}/${baseName}`,
            resolveOpts
        );
        if (attachmentFile != null) {
            return attachmentFile;
        }
    }
    if (hasPathSeparator(normalizedFilepath) && !normalizedFilepath.startsWith("./") && !normalizedFilepath.startsWith("../")) {
        const vaultRelativeFile = await joinFile(vaultConfig.vaultRoot, normalizedFilepath, resolveOpts);
        if (vaultRelativeFile != null) {
            return vaultRelativeFile;
        }
    }
    if (!hasPathSeparator(normalizedFilepath) && baseName) {
        const fileMap = await getObsidianVaultFileMap(vaultConfig, resolveOpts);
        const matchedPath = fileMap.get(baseName);
        if (matchedPath) {
            return {
                path: matchedPath,
                name: getBaseName(matchedPath),
            };
        }
    }
    return null;
}

async function findObsidianAppleStylePlugin(
    vaultConfig: ObsidianVaultConfig,
    resolveOpts: MarkdownResolveOpts
): Promise<(typeof ObsidianAppleStylePluginDefs)[number] | null> {
    for (const pluginDef of ObsidianAppleStylePluginDefs) {
        const pluginManifest = await joinFile(vaultConfig.vaultRoot, pluginDef.manifestPath, resolveOpts);
        if (pluginManifest != null) {
            return pluginDef;
        }
    }
    return null;
}

function normalizeAppleStyleFontSize(value: unknown): AppleStyleFontSize {
    return value === "small" || value === "medium" || value === "large" ? value : "medium";
}

async function getObsidianAppleStyleSettings(
    vaultConfig: ObsidianVaultConfig,
    resolveOpts: MarkdownResolveOpts
): Promise<AppleStyleSettings | null> {
    const pluginDef = await findObsidianAppleStylePlugin(vaultConfig, resolveOpts);
    if (pluginDef == null) {
        return null;
    }
    const settingsFile = await joinFile(vaultConfig.vaultRoot, pluginDef.dataPath, resolveOpts);
    if (settingsFile == null) {
        return DefaultAppleStyleSettings;
    }
    const settingsText = await readTextFile(settingsFile.path, resolveOpts);
    if (!settingsText) {
        return DefaultAppleStyleSettings;
    }
    try {
        const parsed = JSON.parse(settingsText);
        return {
            fontSize: normalizeAppleStyleFontSize(parsed?.fontSize),
            autoUploadImages: parsed?.autoUploadImages ?? DefaultAppleStyleSettings.autoUploadImages,
        };
    } catch {
        return DefaultAppleStyleSettings;
    }
}

async function resolveLocalFileInfo(filepath: string, resolveOpts: MarkdownResolveOpts): Promise<FileInfo | null> {
    let normalizedFilepath = filepath;
    try {
        normalizedFilepath = decodeURI(filepath);
    } catch {
        normalizedFilepath = filepath;
    }
    const relativeFile = await joinFile(resolveOpts.baseDir, normalizedFilepath, resolveOpts);
    if (relativeFile != null) {
        return relativeFile;
    }
    return resolveObsidianFileInfo(normalizedFilepath, resolveOpts);
}

export async function getMarkdownRenderProfile(resolveOpts?: MarkdownResolveOpts): Promise<MarkdownRenderProfile> {
    if (resolveOpts == null) {
        return {
            appleStyle: false,
            appleStyleSettings: DefaultAppleStyleSettings,
        };
    }
    const cacheKey = `${resolveOpts.connName}::${normalizePathSeparators(resolveOpts.baseDir)}`;
    if (!markdownRenderProfileCache.has(cacheKey)) {
        markdownRenderProfileCache.set(
            cacheKey,
            (async () => {
                const vaultConfig = await findObsidianVaultConfig(resolveOpts);
                if (vaultConfig == null) {
                    return {
                        appleStyle: true,
                        appleStyleSettings: DefaultAppleStyleSettings,
                    };
                }
                const appleStyleSettings = await getObsidianAppleStyleSettings(vaultConfig, resolveOpts);
                return {
                    appleStyle: true,
                    appleStyleSettings: appleStyleSettings ?? DefaultAppleStyleSettings,
                };
            })()
        );
    }
    return markdownRenderProfileCache.get(cacheKey);
}

export function preprocessMarkdown(text: string, profile?: MarkdownRenderProfile): string {
    if (!text) {
        return text;
    }
    let processedText = text.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, rawPath, rawAlias) => {
        const imagePath = String(rawPath ?? "").trim();
        if (!looksLikeImagePath(imagePath)) {
            return match;
        }
        const altText = String(rawAlias ?? "").trim();
        return `![${altText}](${imagePath})`;
    });
    if (profile?.appleStyle) {
        processedText = processedText.replace(/^[ \t]*\/\/\/[ \t]*$/gm, "<applespacer></applespacer>");
    }
    return processedText;
}

export function parseMarkdownFrontmatter(text: string): MarkdownFrontmatterParseResult {
    if (!text) {
        return { data: null, raw: null, body: text };
    }
    const normalizedText = text.startsWith("\uFEFF") ? text.slice(1) : text;
    const match = normalizedText.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
    if (!match) {
        return { data: null, raw: null, body: text };
    }
    try {
        const parsed = parseYaml(match[1]);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { data: null, raw: null, body: text };
        }
        return {
            data: parsed as MarkdownFrontmatter,
            raw: match[1],
            body: normalizedText.slice(match[0].length),
        };
    } catch {
        return { data: null, raw: null, body: text };
    }
}

export function formatMarkdownFrontmatterValue(value: unknown): string {
    if (value == null) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (Array.isArray(value)) {
        if (value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
            return value.join(" · ");
        }
        return stringifyYaml(value).trim();
    }
    return stringifyYaml(value).trim();
}

export const resolveRemoteFile = async (filepath: string, resolveOpts: MarkdownResolveOpts): Promise<string | null> => {
    if (!filepath || filepath.startsWith("http://") || filepath.startsWith("https://") || filepath.startsWith("data:")) {
        return filepath;
    }
    try {
        const fileInfo = await resolveLocalFileInfo(filepath, resolveOpts);
        if (fileInfo != null) {
            return makeStreamFileUrl(fileInfo.path, resolveOpts.connName);
        }
        return null;
    } catch (err) {
        console.warn("Failed to resolve remote file:", filepath, err);
        return null;
    }
};

export const resolveRemoteFileInfo = async (
    filepath: string,
    resolveOpts: MarkdownResolveOpts
): Promise<FileInfo | null> => {
    if (!filepath || filepath.startsWith("http://") || filepath.startsWith("https://") || filepath.startsWith("data:")) {
        return null;
    }
    try {
        return await resolveLocalFileInfo(filepath, resolveOpts);
    } catch (err) {
        console.warn("Failed to resolve remote file info:", filepath, err);
        return null;
    }
};

export const resolveSrcSet = async (srcSet: string, resolveOpts: MarkdownResolveOpts): Promise<string> => {
    if (!srcSet) return null;

    // Parse the srcset
    const candidates = parseSrcSet(srcSet);

    // Resolve each URL in the array of candidates
    const resolvedCandidates = await Promise.all(
        candidates.map(async (candidate) => {
            const resolvedUrl = await resolveRemoteFile(candidate.url, resolveOpts);
            return {
                ...candidate,
                url: resolvedUrl,
            };
        })
    );

    // Reconstruct the srcset string
    return resolvedCandidates
        .map((candidate) => {
            let part = candidate.url;
            if (candidate.w) part += ` ${candidate.w}w`;
            if (candidate.h) part += ` ${candidate.h}h`;
            if (candidate.d) part += ` ${candidate.d}x`;
            return part;
        })
        .join(", ");
};
