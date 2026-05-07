package wshremote

import (
	"context"
	"github.com/fsnotify/fsnotify"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestRemoteCopyFileInternalCopiesDirectoryRecursively(t *testing.T) {
	srcRoot := t.TempDir()
	srcDir := filepath.Join(srcRoot, "srcdir")
	if err := os.MkdirAll(filepath.Join(srcDir, "nested"), 0755); err != nil {
		t.Fatalf("mkdir src tree: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "root.txt"), []byte("root"), 0644); err != nil {
		t.Fatalf("write root file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "nested", "child.txt"), []byte("child"), 0644); err != nil {
		t.Fatalf("write nested file: %v", err)
	}

	destParent := t.TempDir()
	if err := remoteCopyFileInternal(srcDir, destParent+"/", srcDir, destParent, true, false, false); err != nil {
		t.Fatalf("copy directory: %v", err)
	}

	destDir := filepath.Join(destParent, filepath.Base(srcDir))
	rootData, err := os.ReadFile(filepath.Join(destDir, "root.txt"))
	if err != nil {
		t.Fatalf("read copied root file: %v", err)
	}
	if string(rootData) != "root" {
		t.Fatalf("unexpected root file contents: %q", string(rootData))
	}

	childData, err := os.ReadFile(filepath.Join(destDir, "nested", "child.txt"))
	if err != nil {
		t.Fatalf("read copied nested file: %v", err)
	}
	if string(childData) != "child" {
		t.Fatalf("unexpected nested file contents: %q", string(childData))
	}
}

func TestRemoteCopyFileInternalRequiresMergeForExistingDirectory(t *testing.T) {
	srcRoot := t.TempDir()
	srcDir := filepath.Join(srcRoot, "srcdir")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatalf("mkdir src dir: %v", err)
	}

	destParent := t.TempDir()
	if err := os.MkdirAll(filepath.Join(destParent, filepath.Base(srcDir)), 0755); err != nil {
		t.Fatalf("mkdir existing dest dir: %v", err)
	}

	err := remoteCopyFileInternal(srcDir, destParent+"/", srcDir, destParent, true, false, false)
	if err == nil {
		t.Fatal("expected merge-required error, got nil")
	}
	if !strings.Contains(err.Error(), "set overwrite flag to delete the existing contents or set merge flag to merge the contents") {
		t.Fatalf("expected merge-required error, got %v", err)
	}
}

func TestRemoteCopyFileInternalMergesIntoExistingDirectory(t *testing.T) {
	srcRoot := t.TempDir()
	srcDir := filepath.Join(srcRoot, "srcdir")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatalf("mkdir src dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "added.txt"), []byte("new"), 0644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	destParent := t.TempDir()
	destDir := filepath.Join(destParent, filepath.Base(srcDir))
	if err := os.MkdirAll(destDir, 0755); err != nil {
		t.Fatalf("mkdir existing dest dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(destDir, "existing.txt"), []byte("old"), 0644); err != nil {
		t.Fatalf("write existing file: %v", err)
	}

	if err := remoteCopyFileInternal(srcDir, destParent+"/", srcDir, destParent, true, false, true); err != nil {
		t.Fatalf("merge directory copy: %v", err)
	}

	existingData, err := os.ReadFile(filepath.Join(destDir, "existing.txt"))
	if err != nil {
		t.Fatalf("read existing file: %v", err)
	}
	if string(existingData) != "old" {
		t.Fatalf("unexpected existing file contents: %q", string(existingData))
	}

	addedData, err := os.ReadFile(filepath.Join(destDir, "added.txt"))
	if err != nil {
		t.Fatalf("read merged file: %v", err)
	}
	if string(addedData) != "new" {
		t.Fatalf("unexpected merged file contents: %q", string(addedData))
	}
}

func TestCheckIsReadOnlyForDirectoryDoesNotEmitTempProbeEvents(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows still uses a temp-file writability probe")
	}

	dir := t.TempDir()
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat temp dir: %v", err)
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("new watcher: %v", err)
	}
	defer watcher.Close()
	if err := watcher.Add(dir); err != nil {
		t.Fatalf("watch temp dir: %v", err)
	}

	if readonly := checkIsReadOnly(dir, info, true); readonly {
		t.Fatalf("expected temp dir to be writable")
	}

	select {
	case event := <-watcher.Events:
		t.Fatalf("unexpected fsnotify event while checking directory writability: %v", event)
	case err := <-watcher.Errors:
		t.Fatalf("unexpected fsnotify error: %v", err)
	case <-time.After(200 * time.Millisecond):
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read temp dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no probe files, found %d entries", len(entries))
	}
}

func TestRemoteListEntriesSkipsInternalProbeFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "visible.txt"), []byte("ok"), 0644); err != nil {
		t.Fatalf("write visible file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "wsh-tmp-34dbe539713e"), []byte("probe"), 0644); err != nil {
		t.Fatalf("write probe file: %v", err)
	}

	impl := &ServerImpl{}
	ch := impl.RemoteListEntriesCommand(
		context.Background(),
		wshrpc.CommandRemoteListEntriesData{Path: dir, Opts: &wshrpc.FileListOpts{}},
	)

	var names []string
	for resp := range ch {
		if resp.Error != nil {
			t.Fatalf("RemoteListEntriesCommand failed: %v", resp.Error)
		}
		for _, info := range resp.Response.FileInfo {
			names = append(names, info.Name)
		}
	}

	if !slices.Contains(names, "visible.txt") {
		t.Fatalf("expected visible.txt in listing, got %v", names)
	}
	if slices.Contains(names, "wsh-tmp-34dbe539713e") {
		t.Fatalf("expected internal probe file to be filtered, got %v", names)
	}
}

func TestRemoteStreamFileDirSkipsInternalProbeFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "visible.txt"), []byte("ok"), 0644); err != nil {
		t.Fatalf("write visible file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "wsh-tmp-34dbe539713e"), []byte("probe"), 0644); err != nil {
		t.Fatalf("write probe file: %v", err)
	}

	impl := &ServerImpl{}
	var names []string
	err := impl.remoteStreamFileInternal(
		context.Background(),
		wshrpc.CommandRemoteStreamFileData{Path: dir},
		func(fileInfo []*wshrpc.FileInfo, _ []byte, _ ByteRangeType) {
			for _, info := range fileInfo {
				if info.Name != "" {
					names = append(names, info.Name)
				}
			}
		},
	)
	if err != nil {
		t.Fatalf("remoteStreamFileInternal failed: %v", err)
	}

	if !slices.Contains(names, "visible.txt") {
		t.Fatalf("expected visible.txt in streamed listing, got %v", names)
	}
	if slices.Contains(names, "wsh-tmp-34dbe539713e") {
		t.Fatalf("expected internal probe file to be filtered, got %v", names)
	}
}
