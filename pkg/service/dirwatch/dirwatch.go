// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package dirwatch

import (
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

var instance *DirWatcher
var once sync.Once

type watchEntry struct {
	blockIds map[string]bool // set of block IDs watching this directory
}

type DirWatcher struct {
	watcher   *fsnotify.Watcher
	mutex     sync.Mutex
	watches   map[string]*watchEntry // path -> watchEntry
	debouncer map[string]*time.Timer // path -> debounce timer
}

const debounceDelay = 100 * time.Millisecond

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
		}
		go instance.run()
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

func (w *DirWatcher) handleEvent(event fsnotify.Event) {
	if event.Op == fsnotify.Chmod {
		return
	}

	dirPath := filepath.Dir(event.Name)
	fileName := filepath.Base(event.Name)

	w.mutex.Lock()
	entry, exists := w.watches[dirPath]
	if !exists {
		w.mutex.Unlock()
		return
	}
	blockIds := make([]string, 0, len(entry.blockIds))
	for blockId := range entry.blockIds {
		blockIds = append(blockIds, blockId)
	}

	// debounce: cancel existing timer and create new one
	if timer, ok := w.debouncer[dirPath]; ok {
		timer.Stop()
	}
	w.debouncer[dirPath] = time.AfterFunc(debounceDelay, func() {
		w.publishEvent(dirPath, event.Op.String(), fileName, blockIds)
	})
	w.mutex.Unlock()
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

	// Expand ~ to home directory
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

	// Clean the path
	dirPath = filepath.Clean(dirPath)

	w.mutex.Lock()
	defer w.mutex.Unlock()

	entry, exists := w.watches[dirPath]
	if !exists {
		// Add new watch
		err := w.watcher.Add(dirPath)
		if err != nil {
			return err
		}
		entry = &watchEntry{
			blockIds: make(map[string]bool),
		}
		w.watches[dirPath] = entry
	}
	entry.blockIds[blockId] = true
	return nil
}

// Unsubscribe removes a watch for a directory path associated with a block
func (w *DirWatcher) Unsubscribe(dirPath string, blockId string) {
	if w == nil || w.watcher == nil {
		return
	}

	// Expand ~ to home directory
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

	// Clean the path
	dirPath = filepath.Clean(dirPath)

	w.mutex.Lock()
	defer w.mutex.Unlock()

	entry, exists := w.watches[dirPath]
	if !exists {
		return
	}

	delete(entry.blockIds, blockId)

	// If no more blocks watching this path, remove the watch
	if len(entry.blockIds) == 0 {
		w.watcher.Remove(dirPath)
		delete(w.watches, dirPath)
		if timer, ok := w.debouncer[dirPath]; ok {
			timer.Stop()
			delete(w.debouncer, dirPath)
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
	w.watcher.Close()
}
