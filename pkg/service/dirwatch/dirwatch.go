// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package dirwatch

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

var instance *DirWatcher
var once sync.Once

type watchEntry struct {
	// A block can subscribe to both a parent directory and one of its expanded
	// descendants. Track a per-block refcount so unsubscribing the child path does
	// not accidentally tear down the parent's recursive watch.
	blockIds map[string]int
}

type dirSnapshotEntry struct {
	IsDir        bool
	Size         int64
	ModifiedNsec int64
}

type dirSnapshot map[string]dirSnapshotEntry

type DirWatcher struct {
	watcher   *fsnotify.Watcher
	mutex     sync.Mutex
	watches   map[string]*watchEntry // path -> watchEntry
	debouncer map[string]*time.Timer // path -> debounce timer
	snapshots map[string]dirSnapshot
}

const debounceDelay = 100 * time.Millisecond
const pollFallbackInterval = 2 * time.Second

func normalizeDirPath(dirPath string) string {
	if dirPath == "~" || len(dirPath) > 1 && dirPath[:2] == "~/" {
		homeDir, err := os.UserHomeDir()
		if err == nil {
			if dirPath == "~" {
				dirPath = homeDir
			} else {
				dirPath = filepath.Join(homeDir, dirPath[2:])
			}
		}
	}
	return filepath.Clean(dirPath)
}

func isSameOrDescendantPath(path string, root string) bool {
	if path == root {
		return true
	}
	rootWithSep := root
	if !strings.HasSuffix(rootWithSep, string(os.PathSeparator)) {
		rootWithSep += string(os.PathSeparator)
	}
	return strings.HasPrefix(path, rootWithSep)
}

func collectDirectoryTree(dirPath string) ([]string, error) {
	var dirs []string
	err := filepath.WalkDir(dirPath, func(walkPath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		dirs = append(dirs, filepath.Clean(walkPath))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return dirs, nil
}

func scanDirectorySnapshot(dirPath string) (dirSnapshot, error) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}
	snapshot := make(dirSnapshot, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if fileutil.IsInternalTempProbeFileName(name) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		snapshot[name] = dirSnapshotEntry{
			IsDir:        entry.IsDir(),
			Size:         info.Size(),
			ModifiedNsec: info.ModTime().UnixNano(),
		}
	}
	return snapshot, nil
}

type snapshotDelta struct {
	Event string
	Name  string
}

func diffDirectorySnapshots(prev dirSnapshot, current dirSnapshot) []snapshotDelta {
	if prev == nil {
		prev = dirSnapshot{}
	}
	if current == nil {
		current = dirSnapshot{}
	}
	deltas := make([]snapshotDelta, 0)
	for name, currentEntry := range current {
		prevEntry, exists := prev[name]
		if !exists {
			deltas = append(deltas, snapshotDelta{Event: "CREATE", Name: name})
			continue
		}
		if prevEntry != currentEntry {
			deltas = append(deltas, snapshotDelta{Event: "WRITE", Name: name})
		}
	}
	for name := range prev {
		if _, exists := current[name]; !exists {
			deltas = append(deltas, snapshotDelta{Event: "REMOVE", Name: name})
		}
	}
	return deltas
}

func (w *DirWatcher) ensureWatchLocked(dirPath string) (*watchEntry, error) {
	entry, exists := w.watches[dirPath]
	if exists {
		return entry, nil
	}
	if err := w.watcher.Add(dirPath); err != nil {
		return nil, err
	}
	entry = &watchEntry{
		blockIds: make(map[string]int),
	}
	w.watches[dirPath] = entry
	snapshot, err := scanDirectorySnapshot(dirPath)
	if err == nil {
		w.snapshots[dirPath] = snapshot
	}
	return entry, nil
}

func (w *DirWatcher) subscribeTreeLocked(dirPath string, blockCounts map[string]int) error {
	dirs, err := collectDirectoryTree(dirPath)
	if err != nil {
		return err
	}
	for _, watchPath := range dirs {
		entry, err := w.ensureWatchLocked(watchPath)
		if err != nil {
			return err
		}
		for blockId, count := range blockCounts {
			entry.blockIds[blockId] += count
		}
	}
	return nil
}

func (w *DirWatcher) cleanupWatchTreeLocked(dirPath string) {
	for watchPath := range w.watches {
		if !isSameOrDescendantPath(watchPath, dirPath) {
			continue
		}
		if timer, ok := w.debouncer[watchPath]; ok {
			timer.Stop()
			delete(w.debouncer, watchPath)
		}
		_ = w.watcher.Remove(watchPath)
		delete(w.watches, watchPath)
		delete(w.snapshots, watchPath)
	}
}

func (w *DirWatcher) addTreeForBlocks(dirPath string, blockCounts map[string]int) {
	if len(blockCounts) == 0 {
		return
	}
	dirPath = normalizeDirPath(dirPath)
	info, err := os.Stat(dirPath)
	if err != nil || !info.IsDir() {
		return
	}
	w.mutex.Lock()
	defer w.mutex.Unlock()
	if err := w.subscribeTreeLocked(dirPath, blockCounts); err != nil {
		log.Printf("failed to recursively watch %s: %v", dirPath, err)
	}
}

// GetDirWatcher returns the singleton instance of DirWatcher
func GetDirWatcher() *DirWatcher {
	once.Do(func() {
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			log.Printf("failed to create directory watcher: %v", err)
			return
		}
		instance = &DirWatcher{
			watcher:   watcher,
			watches:   make(map[string]*watchEntry),
			debouncer: make(map[string]*time.Timer),
			snapshots: make(map[string]dirSnapshot),
		}
		go instance.run()
		go instance.pollLoop()
	})
	return instance
}

func (w *DirWatcher) run() {
	defer func() {
		panichandler.PanicHandler("dirwatch:run", recover())
	}()
	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			w.handleEvent(event)
		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			log.Println("dirwatch error:", err)
		}
	}
}

func (w *DirWatcher) pollLoop() {
	ticker := time.NewTicker(pollFallbackInterval)
	defer ticker.Stop()
	for range ticker.C {
		w.pollOnce()
	}
}

func (w *DirWatcher) pollOnce() {
	if w == nil || w.watcher == nil {
		return
	}
	w.mutex.Lock()
	targets := make([]string, 0, len(w.watches))
	for dirPath := range w.watches {
		targets = append(targets, dirPath)
	}
	w.mutex.Unlock()

	for _, dirPath := range targets {
		w.publishSnapshotDiff(dirPath)
	}
}

func (w *DirWatcher) syncSnapshot(dirPath string) {
	if w == nil || w.watcher == nil {
		return
	}
	snapshot, err := scanDirectorySnapshot(dirPath)
	if err != nil {
		return
	}
	w.mutex.Lock()
	defer w.mutex.Unlock()
	if _, exists := w.watches[dirPath]; !exists {
		return
	}
	w.snapshots[dirPath] = snapshot
}

func (w *DirWatcher) publishSnapshotDiff(dirPath string) {
	if w == nil || w.watcher == nil {
		return
	}
	currentSnapshot, err := scanDirectorySnapshot(dirPath)
	if err != nil {
		return
	}

	w.mutex.Lock()
	entry, exists := w.watches[dirPath]
	if !exists {
		w.mutex.Unlock()
		return
	}
	prevSnapshot := w.snapshots[dirPath]
	w.snapshots[dirPath] = currentSnapshot
	delete(w.debouncer, dirPath)
	blockIds := make([]string, 0, len(entry.blockIds))
	for blockId := range entry.blockIds {
		blockIds = append(blockIds, blockId)
	}
	w.mutex.Unlock()

	deltas := diffDirectorySnapshots(prevSnapshot, currentSnapshot)
	for _, delta := range deltas {
		w.publishEvent(dirPath, delta.Event, delta.Name, blockIds)
	}
}

func (w *DirWatcher) handleEvent(event fsnotify.Event) {
	if event.Op == fsnotify.Chmod {
		return
	}

	eventPath := filepath.Clean(event.Name)
	dirPath := filepath.Dir(eventPath)
	fileName := filepath.Base(eventPath)
	if fileutil.IsInternalTempProbeFileName(fileName) {
		return
	}

	w.mutex.Lock()
	entry, exists := w.watches[dirPath]
	if !exists {
		if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
			if _, watched := w.watches[eventPath]; watched {
				w.cleanupWatchTreeLocked(eventPath)
			}
		}
		w.mutex.Unlock()
		return
	}
	blockCounts := make(map[string]int, len(entry.blockIds))
	for blockId, count := range entry.blockIds {
		blockCounts[blockId] = count
	}

	// Debounce per directory so tools that write through temp files or emit
	// create/write/rename bursts only trigger a single UI refresh. We rescan
	// the directory after the burst so atomic-save flows still report the real
	// target file instead of the last temp-file event name.
	if timer, ok := w.debouncer[dirPath]; ok {
		timer.Stop()
	}
	w.debouncer[dirPath] = time.AfterFunc(debounceDelay, func() {
		w.publishSnapshotDiff(dirPath)
	})
	if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
		if _, watched := w.watches[eventPath]; watched {
			w.cleanupWatchTreeLocked(eventPath)
		}
	}
	w.mutex.Unlock()

	if event.Op&(fsnotify.Create|fsnotify.Rename) != 0 {
		w.addTreeForBlocks(eventPath, blockCounts)
	}
}

func (w *DirWatcher) publishEvent(dirPath, eventType, fileName string, blockIds []string) {
	for _, blockId := range blockIds {
		wps.Broker.Publish(wps.WaveEvent{
			Event:  wps.Event_DirWatch,
			Scopes: []string{"block:" + blockId},
			Data: wps.DirWatchEventData{
				DirPath: dirPath,
				Event:   eventType,
				Name:    fileName,
			},
		})
	}
}

// Subscribe adds a watch for a directory path associated with a block
func (w *DirWatcher) Subscribe(dirPath string, blockId string) error {
	if w == nil || w.watcher == nil {
		return nil
	}
	dirPath = normalizeDirPath(dirPath)

	w.mutex.Lock()
	defer w.mutex.Unlock()
	return w.subscribeTreeLocked(dirPath, map[string]int{blockId: 1})
}

// Unsubscribe removes a watch for a directory path associated with a block
func (w *DirWatcher) Unsubscribe(dirPath string, blockId string) {
	if w == nil || w.watcher == nil {
		return
	}
	dirPath = normalizeDirPath(dirPath)

	w.mutex.Lock()
	defer w.mutex.Unlock()
	for watchPath, entry := range w.watches {
		if !isSameOrDescendantPath(watchPath, dirPath) {
			continue
		}
		// Only remove the block from this watched path when every overlapping
		// subscription from that block has been released.
		if count, ok := entry.blockIds[blockId]; ok {
			if count <= 1 {
				delete(entry.blockIds, blockId)
			} else {
				entry.blockIds[blockId] = count - 1
			}
		}
		if len(entry.blockIds) == 0 {
			_ = w.watcher.Remove(watchPath)
			delete(w.watches, watchPath)
			delete(w.snapshots, watchPath)
			if timer, ok := w.debouncer[watchPath]; ok {
				timer.Stop()
				delete(w.debouncer, watchPath)
			}
		}
	}
}

// Close shuts down the watcher
func (w *DirWatcher) Close() {
	if w == nil || w.watcher == nil {
		return
	}
	w.mutex.Lock()
	defer w.mutex.Unlock()
	for dirPath := range w.watches {
		_ = w.watcher.Remove(dirPath)
	}
	for dirPath, timer := range w.debouncer {
		timer.Stop()
		delete(w.debouncer, dirPath)
	}
	clear(w.watches)
	clear(w.snapshots)
	w.watcher.Close()
}
