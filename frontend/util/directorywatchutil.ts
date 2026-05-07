export type DirectorySortMode = "name" | "type" | "size" | "modified";

const internalProbeNameRe = /^wsh-tmp-[0-9a-f]{12,}$/i;

export function isInternalDirectoryProbeName(name?: string | null): boolean {
    return !!name && internalProbeNameRe.test(name);
}

export function normalizeDirectoryWatchPath(path?: string | null, homeDir?: string | null): string | undefined {
    if (!path) {
        return undefined;
    }

    const normalizeSeparators = (value: string) => value.replace(/\\/g, "/");
    let normalized = normalizeSeparators(path);
    if (normalized.length > 1) {
        normalized = normalized.replace(/\/+$/, "");
    }

    if (normalized === "~" || normalized.startsWith("~/")) {
        return normalized;
    }

    if (!homeDir) {
        return normalized;
    }

    const normalizedHome = normalizeSeparators(homeDir).replace(/\/+$/, "");
    if (!normalizedHome) {
        return normalized;
    }
    if (normalized === normalizedHome) {
        return "~";
    }
    if (normalized.startsWith(`${normalizedHome}/`)) {
        return `~${normalized.slice(normalizedHome.length)}`;
    }
    return normalized;
}

function normalizeDirectoryTreePath(path?: string | null): string | undefined {
    if (!path) {
        return undefined;
    }
    let normalized = path.replace(/\\/g, "/");
    if (normalized.length > 1) {
        normalized = normalized.replace(/\/+$/, "");
    }
    return normalized || "/";
}

function isVolumesPath(path?: string): boolean {
    return path === "/Volumes" || !!path?.startsWith("/Volumes/");
}

function joinDirectoryEventPath(dirPath?: string | null, name?: string | null): string | undefined {
    const normalizedDirPath = normalizeDirectoryTreePath(dirPath);
    if (!normalizedDirPath) {
        return undefined;
    }
    const normalizedName = name?.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!normalizedName) {
        return normalizedDirPath;
    }
    if (normalizedDirPath === "/") {
        return `/${normalizedName}`;
    }
    return `${normalizedDirPath}/${normalizedName}`;
}

// Avoid auto-reading /Volumes as a child directory. Finder and macOS may
// briefly touch removable/network volumes there, which creates visible flicker.
// If the user explicitly opens /Volumes (or a mounted volume inside it), allow
// normal reads for that root view.
export function shouldSkipAutoDirectoryRead(path?: string | null, rootDirPath?: string | null): boolean {
    const normalizedPath = normalizeDirectoryTreePath(path);
    if (!isVolumesPath(normalizedPath)) {
        return false;
    }
    const normalizedRootDirPath = normalizeDirectoryTreePath(rootDirPath);
    return !isVolumesPath(normalizedRootDirPath);
}

// Ignore dirwatch events that only touch /Volumes while browsing another root.
// This avoids repeated root refreshes from system mount churn.
export function shouldIgnoreVolumesDirectoryWatchEvent(
    rootDirPath?: string | null,
    changedDirPath?: string | null,
    changedName?: string | null
): boolean {
    const normalizedRootDirPath = normalizeDirectoryTreePath(rootDirPath);
    if (isVolumesPath(normalizedRootDirPath)) {
        return false;
    }
    const changedPath = joinDirectoryEventPath(changedDirPath, changedName);
    return isVolumesPath(changedPath);
}

// Structural changes always need a refresh because they affect which rows exist.
export function isStructuralDirWatchEvent(eventType?: string): boolean {
    if (!eventType) {
        return true;
    }
    const normalized = eventType.toUpperCase();
    return normalized.includes("CREATE") || normalized.includes("REMOVE") || normalized.includes("RENAME");
}

// In a file workbench, users expect the visible directory to stay in sync even
// when a write only changes metadata or nested state. Refresh on every emitted
// event and let higher-level debouncing keep the UI stable.
export function shouldRefreshDirectoryForEvent(eventType: string | undefined, sortMode: DirectorySortMode): boolean {
    void sortMode;
    return true;
}
