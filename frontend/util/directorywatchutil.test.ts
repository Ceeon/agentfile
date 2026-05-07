import { assert, test } from "vitest";
import {
    isInternalDirectoryProbeName,
    isStructuralDirWatchEvent,
    normalizeDirectoryWatchPath,
    shouldIgnoreVolumesDirectoryWatchEvent,
    shouldSkipAutoDirectoryRead,
    shouldRefreshDirectoryForEvent,
} from "./directorywatchutil";

test("internal probe filenames are identified for filtering", () => {
    assert.isTrue(isInternalDirectoryProbeName("wsh-tmp-34dbe539713e"));
    assert.isTrue(isInternalDirectoryProbeName("wsh-tmp-ABCDEF123456"));
    assert.isFalse(isInternalDirectoryProbeName("wsh-tmp-123"));
    assert.isFalse(isInternalDirectoryProbeName("wsh-tmp-34dbe539713e.txt"));
    assert.isFalse(isInternalDirectoryProbeName("notes.md"));
});

test("structural dirwatch events refresh regardless of sort mode", () => {
    assert.isTrue(isStructuralDirWatchEvent("CREATE"));
    assert.isTrue(isStructuralDirWatchEvent("REMOVE"));
    assert.isTrue(isStructuralDirWatchEvent("RENAME"));
    assert.isTrue(isStructuralDirWatchEvent("CREATE|WRITE"));
    assert.isTrue(shouldRefreshDirectoryForEvent("RENAME", "name"));
});

test("write-only events also refresh directory views immediately", () => {
    assert.isFalse(isStructuralDirWatchEvent("WRITE"));
    assert.isTrue(shouldRefreshDirectoryForEvent("WRITE", "name"));
    assert.isTrue(shouldRefreshDirectoryForEvent("WRITE", "type"));
    assert.isTrue(shouldRefreshDirectoryForEvent("WRITE", "size"));
    assert.isTrue(shouldRefreshDirectoryForEvent("WRITE", "modified"));
});

test("watch paths normalize absolute home paths to the UI's tilde form", () => {
    assert.strictEqual(normalizeDirectoryWatchPath("/Users/chengfeng", "/Users/chengfeng"), "~");
    assert.strictEqual(normalizeDirectoryWatchPath("/Users/chengfeng/Desktop/demo", "/Users/chengfeng"), "~/Desktop/demo");
    assert.strictEqual(normalizeDirectoryWatchPath("~/Desktop/demo", "/Users/chengfeng"), "~/Desktop/demo");
    assert.strictEqual(
        normalizeDirectoryWatchPath("C:\\Users\\chengfeng\\Desktop\\demo\\", "C:\\Users\\chengfeng"),
        "~/Desktop/demo"
    );
    assert.strictEqual(normalizeDirectoryWatchPath("/tmp/demo/", "/Users/chengfeng"), "/tmp/demo");
});

test("auto child reads skip /Volumes unless it is the explicit root view", () => {
    assert.isTrue(shouldSkipAutoDirectoryRead("/Volumes", "/"));
    assert.isTrue(shouldSkipAutoDirectoryRead("/Volumes/External", "/"));
    assert.isTrue(shouldSkipAutoDirectoryRead("/Volumes", "/Users/chengfeng"));
    assert.isFalse(shouldSkipAutoDirectoryRead("/Volumes", "/Volumes"));
    assert.isFalse(shouldSkipAutoDirectoryRead("/Volumes/External", "/Volumes"));
    assert.isFalse(shouldSkipAutoDirectoryRead("/Volumes/External", "/Volumes/External"));
    assert.isFalse(shouldSkipAutoDirectoryRead("/tmp/demo", "/"));
});

test("dirwatch ignores /Volumes churn unless /Volumes is the active root", () => {
    assert.isTrue(shouldIgnoreVolumesDirectoryWatchEvent("/", "/", "Volumes"));
    assert.isTrue(shouldIgnoreVolumesDirectoryWatchEvent("/", "/Volumes", "External"));
    assert.isTrue(shouldIgnoreVolumesDirectoryWatchEvent("/Users/chengfeng", "/Volumes", "External"));
    assert.isFalse(shouldIgnoreVolumesDirectoryWatchEvent("/Volumes", "/", "Volumes"));
    assert.isFalse(shouldIgnoreVolumesDirectoryWatchEvent("/Volumes/External", "/Volumes/External", "demo.txt"));
    assert.isFalse(shouldIgnoreVolumesDirectoryWatchEvent("/", "/Users/chengfeng", "demo.txt"));
});
