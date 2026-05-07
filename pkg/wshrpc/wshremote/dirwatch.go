// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
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
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

type remoteWatchEntry struct {
	blockIds map[string]int
}

type remoteDirSnapshotEntry struct {
	IsDir        bool
	Size         int64
	ModifiedNsec int64
}

type remoteDirSnapshot map[string]remoteDirSnapshotEntry

type remoteDirWatcher struct {
	impl      *ServerImpl
	watcher   *fsnotify.Watcher
	mutex     sync.Mutex
	watches   map[string]*remoteWatchEntry
	debouncer map[string]*time.Timer
	snapshots map[string]remoteDirSnapshot
}

const remoteDirWatchDebounceDelay = 100 * time.Millisecond
const remoteDirWatchPollFallbackInterval = 2 * time.Second

func normalizeRemoteDirPath(dirPath string) string {
	return filepath.Clean(wavebase.ExpandHomeDirSafe(dirPath))
}

func isSameOrDescendantRemotePath(path string, root string) bool {
	if path == root {
		return true
	}
	rootWithSep := root
	if !strings.HasSuffix(rootWithSep, string(os.PathSeparator)) {
		rootWithSep += string(os.PathSeparator)
	}
	return strings.HasPrefix(path, rootWithSep)
}

func collectRemoteDirectoryTree(dirPath string) ([]string, error) {
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

func scanRemoteDirectorySnapshot(dirPath string) (remoteDirSnapshot, error) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}
	snapshot := make(remoteDirSnapshot, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if fileutil.IsInternalTempProbeFileName(name) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		snapshot[name] = remoteDirSnapshotEntry{
			IsDir:        entry.IsDir(),
			Size:         info.Size(),
			ModifiedNsec: info.ModTime().UnixNano(),
		}
	}
	return snapshot, nil
}

type remoteSnapshotDelta struct {
	Event string
	Name  string
}

func diffRemoteDirectorySnapshots(prev remoteDirSnapshot, current remoteDirSnapshot) []remoteSnapshotDelta {
	if prev == nil {
		prev = remoteDirSnapshot{}
	}
	if current == nil {
		current = remoteDirSnapshot{}
	}
	deltas := make([]remoteSnapshotDelta, 0)
	for name, currentEntry := range current {
		prevEntry, exists := prev[name]
		if !exists {
			deltas = append(deltas, remoteSnapshotDelta{Event: "CREATE", Name: name})
			continue
		}
		if prevEntry != currentEntry {
			deltas = append(deltas, remoteSnapshotDelta{Event: "WRITE", Name: name})
		}
	}
	for name := range prev {
		if _, exists := current[name]; !exists {
			deltas = append(deltas, remoteSnapshotDelta{Event: "REMOVE", Name: name})
		}
	}
	return deltas
}

func newRemoteDirWatcher(impl *ServerImpl) (*remoteDirWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	rw := &remoteDirWatcher{
		impl:      impl,
		watcher:   watcher,
		watches:   make(map[string]*remoteWatchEntry),
		debouncer: make(map[string]*time.Timer),
		snapshots: make(map[string]remoteDirSnapshot),
	}
	go rw.run()
	go rw.pollLoop()
	return rw, nil
}

func (impl *ServerImpl) getDirWatcher() (*remoteDirWatcher, error) {
	impl.Lock.Lock()
	defer impl.Lock.Unlock()
	if impl.dirWatcher != nil {
		return impl.dirWatcher, nil
	}
	watcher, err := newRemoteDirWatcher(impl)
	if err != nil {
		return nil, err
	}
	impl.dirWatcher = watcher
	return watcher, nil
}

func (w *remoteDirWatcher) ensureWatchLocked(dirPath string) (*remoteWatchEntry, error) {
	entry, exists := w.watches[dirPath]
	if exists {
		return entry, nil
	}
	if err := w.watcher.Add(dirPath); err != nil {
		return nil, err
	}
	entry = &remoteWatchEntry{blockIds: make(map[string]int)}
	w.watches[dirPath] = entry
	snapshot, err := scanRemoteDirectorySnapshot(dirPath)
	if err == nil {
		w.snapshots[dirPath] = snapshot
	}
	return entry, nil
}

func (w *remoteDirWatcher) subscribeTreeLocked(dirPath string, blockCounts map[string]int) error {
	dirs, err := collectRemoteDirectoryTree(dirPath)
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

func (w *remoteDirWatcher) cleanupWatchTreeLocked(dirPath string) {
	for watchPath := range w.watches {
		if !isSameOrDescendantRemotePath(watchPath, dirPath) {
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

func (w *remoteDirWatcher) addTreeForBlocks(dirPath string, blockCounts map[string]int) {
	if len(blockCounts) == 0 {
		return
	}
	dirPath = normalizeRemoteDirPath(dirPath)
	info, err := os.Stat(dirPath)
	if err != nil || !info.IsDir() {
		return
	}
	w.mutex.Lock()
	defer w.mutex.Unlock()
	if err := w.subscribeTreeLocked(dirPath, blockCounts); err != nil {
		log.Printf("failed to recursively watch remote dir %s: %v", dirPath, err)
	}
}

func (w *remoteDirWatcher) run() {
	defer func() {
		panichandler.PanicHandler("wshremote:dirwatch:run", recover())
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
			log.Printf("remote dirwatch error: %v", err)
		}
	}
}

func (w *remoteDirWatcher) pollLoop() {
	ticker := time.NewTicker(remoteDirWatchPollFallbackInterval)
	defer ticker.Stop()
	for range ticker.C {
		w.pollOnce()
	}
}

func (w *remoteDirWatcher) pollOnce() {
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

func (w *remoteDirWatcher) syncSnapshot(dirPath string) {
	if w == nil || w.watcher == nil {
		return
	}
	snapshot, err := scanRemoteDirectorySnapshot(dirPath)
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

func (w *remoteDirWatcher) publishSnapshotDiff(dirPath string) {
	if w == nil || w.watcher == nil {
		return
	}
	currentSnapshot, err := scanRemoteDirectorySnapshot(dirPath)
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

	deltas := diffRemoteDirectorySnapshots(prevSnapshot, currentSnapshot)
	for _, delta := range deltas {
		w.publishEvent(dirPath, delta.Event, delta.Name, blockIds)
	}
}

func (w *remoteDirWatcher) handleEvent(event fsnotify.Event) {
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

	if timer, ok := w.debouncer[dirPath]; ok {
		timer.Stop()
	}
	w.debouncer[dirPath] = time.AfterFunc(remoteDirWatchDebounceDelay, func() {
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

func (w *remoteDirWatcher) publishEvent(dirPath, eventType, fileName string, blockIds []string) {
	if w == nil || w.impl == nil || w.impl.RpcClient == nil {
		return
	}
	for _, blockId := range blockIds {
		err := wshclient.EventPublishCommand(w.impl.RpcClient, wps.WaveEvent{
			Event:  wps.Event_DirWatch,
			Scopes: []string{"block:" + blockId},
			Data: wps.DirWatchEventData{
				DirPath: dirPath,
				Event:   eventType,
				Name:    fileName,
			},
		}, &wshrpc.RpcOpts{NoResponse: true})
		if err != nil {
			log.Printf("failed to publish remote dirwatch event: %v", err)
		}
	}
}

func (w *remoteDirWatcher) Subscribe(dirPath string, blockId string) error {
	if w == nil || w.watcher == nil {
		return nil
	}
	dirPath = normalizeRemoteDirPath(dirPath)
	w.mutex.Lock()
	defer w.mutex.Unlock()
	return w.subscribeTreeLocked(dirPath, map[string]int{blockId: 1})
}

func (w *remoteDirWatcher) Unsubscribe(dirPath string, blockId string) {
	if w == nil || w.watcher == nil {
		return
	}
	dirPath = normalizeRemoteDirPath(dirPath)
	w.mutex.Lock()
	defer w.mutex.Unlock()
	for watchPath, entry := range w.watches {
		if !isSameOrDescendantRemotePath(watchPath, dirPath) {
			continue
		}
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

func (impl *ServerImpl) DirWatchSubscribeCommand(ctx context.Context, data wshrpc.DirWatchData) error {
	_ = ctx
	watcher, err := impl.getDirWatcher()
	if err != nil {
		return err
	}
	return watcher.Subscribe(data.DirPath, data.BlockId)
}

func (impl *ServerImpl) DirWatchUnsubscribeCommand(ctx context.Context, data wshrpc.DirWatchData) error {
	_ = ctx
	watcher, err := impl.getDirWatcher()
	if err != nil {
		return nil
	}
	watcher.Unsubscribe(data.DirPath, data.BlockId)
	return nil
}
