package dirwatch

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

type testBrokerClient struct {
	eventCh chan wps.WaveEvent
}

func (c *testBrokerClient) SendEvent(_ string, event wps.WaveEvent) {
	c.eventCh <- event
}

func newTestDirWatcher(t *testing.T) *DirWatcher {
	t.Helper()
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("NewWatcher failed: %v", err)
	}
	dw := &DirWatcher{
		watcher:   watcher,
		watches:   make(map[string]*watchEntry),
		debouncer: make(map[string]*time.Timer),
		snapshots: make(map[string]dirSnapshot),
	}
	t.Cleanup(func() {
		dw.Close()
	})
	return dw
}

func assertWatchedByBlock(t *testing.T, dw *DirWatcher, dirPath string, blockId string) {
	t.Helper()
	dw.mutex.Lock()
	defer dw.mutex.Unlock()
	entry, ok := dw.watches[dirPath]
	if !ok {
		t.Fatalf("expected %s to be watched", dirPath)
	}
	if entry.blockIds[blockId] <= 0 {
		t.Fatalf("expected %s to be watched by %s", dirPath, blockId)
	}
}

func assertNotWatchedByBlock(t *testing.T, dw *DirWatcher, dirPath string, blockId string) {
	t.Helper()
	dw.mutex.Lock()
	defer dw.mutex.Unlock()
	entry, ok := dw.watches[dirPath]
	if !ok {
		return
	}
	if entry.blockIds[blockId] > 0 {
		t.Fatalf("expected %s to not be watched by %s", dirPath, blockId)
	}
}

func setupDirWatchEventCapture(t *testing.T, routeId string, scope string) <-chan wps.WaveEvent {
	t.Helper()
	eventCh := make(chan wps.WaveEvent, 16)
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(&testBrokerClient{eventCh: eventCh})
	wps.Broker.Subscribe(routeId, wps.SubscriptionRequest{
		Event:  wps.Event_DirWatch,
		Scopes: []string{scope},
	})
	t.Cleanup(func() {
		wps.Broker.UnsubscribeAll(routeId)
		wps.Broker.SetClient(prevClient)
		close(eventCh)
	})
	return eventCh
}

func waitForDirWatchEvent(t *testing.T, eventCh <-chan wps.WaveEvent, expectedName string) wps.DirWatchEventData {
	t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case event := <-eventCh:
			if event.Event != wps.Event_DirWatch {
				continue
			}
			data, ok := event.Data.(wps.DirWatchEventData)
			if !ok {
				t.Fatalf("expected dirwatch data, got %T", event.Data)
			}
			if data.Name != expectedName {
				continue
			}
			return data
		case <-timeout:
			t.Fatalf("timed out waiting for dirwatch event for %s", expectedName)
		}
	}
}

func assertNoDirWatchEvent(t *testing.T, eventCh <-chan wps.WaveEvent, wait time.Duration) {
	t.Helper()
	select {
	case event := <-eventCh:
		t.Fatalf("expected no dirwatch event, got %#v", event)
	case <-time.After(wait):
	}
}

func TestSubscribeRecursivelyWatchesExistingSubdirectories(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	dw := newTestDirWatcher(t)
	if err := dw.Subscribe(root, "block-1"); err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}

	assertWatchedByBlock(t, dw, root, "block-1")
	assertWatchedByBlock(t, dw, filepath.Join(root, "a"), "block-1")
	assertWatchedByBlock(t, dw, nested, "block-1")
}

func TestHandleEventAddsNewDirectChildSubdirectoriesRecursively(t *testing.T) {
	root := t.TempDir()
	dw := newTestDirWatcher(t)
	if err := dw.Subscribe(root, "block-1"); err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}

	newDir := filepath.Join(root, "new-child")
	if err := os.MkdirAll(filepath.Join(newDir, "nested"), 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	dw.handleEvent(fsnotify.Event{Name: newDir, Op: fsnotify.Create})

	assertWatchedByBlock(t, dw, newDir, "block-1")
	assertWatchedByBlock(t, dw, filepath.Join(newDir, "nested"), "block-1")
}

func TestUnsubscribeKeepsIndependentNestedWatchers(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "child")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	dw := newTestDirWatcher(t)
	if err := dw.Subscribe(root, "root-block"); err != nil {
		t.Fatalf("Subscribe root failed: %v", err)
	}
	if err := dw.Subscribe(child, "child-block"); err != nil {
		t.Fatalf("Subscribe child failed: %v", err)
	}

	dw.Unsubscribe(root, "root-block")

	dw.mutex.Lock()
	defer dw.mutex.Unlock()

	if _, ok := dw.watches[root]; ok {
		t.Fatalf("expected root watch to be removed")
	}

	childEntry, ok := dw.watches[child]
	if !ok {
		t.Fatalf("expected child watch to remain")
	}
	if childEntry.blockIds["root-block"] > 0 {
		t.Fatalf("expected root-block to be removed from child watch")
	}
	if childEntry.blockIds["child-block"] <= 0 {
		t.Fatalf("expected child-block to remain on child watch")
	}
}

func TestUnsubscribeChildPathKeepsCoverageFromRootWatchForSameBlock(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "child", "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	child := filepath.Join(root, "child")
	dw := newTestDirWatcher(t)
	if err := dw.Subscribe(root, "block-1"); err != nil {
		t.Fatalf("Subscribe root failed: %v", err)
	}
	if err := dw.Subscribe(child, "block-1"); err != nil {
		t.Fatalf("Subscribe child failed: %v", err)
	}

	dw.Unsubscribe(child, "block-1")

	assertWatchedByBlock(t, dw, root, "block-1")
	assertWatchedByBlock(t, dw, child, "block-1")
	assertWatchedByBlock(t, dw, nested, "block-1")
}

func TestNewSubdirectoriesRemainWatchedAfterChildUnsubscribeWhenRootWatchRemains(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "child")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	dw := newTestDirWatcher(t)
	if err := dw.Subscribe(root, "block-1"); err != nil {
		t.Fatalf("Subscribe root failed: %v", err)
	}
	if err := dw.Subscribe(child, "block-1"); err != nil {
		t.Fatalf("Subscribe child failed: %v", err)
	}

	newDir := filepath.Join(child, "new-child")
	newNested := filepath.Join(newDir, "nested")
	if err := os.MkdirAll(newNested, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	dw.handleEvent(fsnotify.Event{Name: newDir, Op: fsnotify.Create})
	dw.Unsubscribe(child, "block-1")

	assertWatchedByBlock(t, dw, child, "block-1")
	assertWatchedByBlock(t, dw, newDir, "block-1")
	assertWatchedByBlock(t, dw, newNested, "block-1")
	assertNotWatchedByBlock(t, dw, newDir, "missing-block")
}

func TestFsnotifyStillPublishesNestedFileChangesAfterChildUnsubscribeWhenRootWatchRemains(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "child", "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	dw := newTestDirWatcher(t)
	go dw.run()

	eventCh := setupDirWatchEventCapture(t, "route-test-dirwatch", "block:block-1")
	child := filepath.Join(root, "child")
	if err := dw.Subscribe(root, "block-1"); err != nil {
		t.Fatalf("Subscribe root failed: %v", err)
	}
	if err := dw.Subscribe(child, "block-1"); err != nil {
		t.Fatalf("Subscribe child failed: %v", err)
	}

	dw.Unsubscribe(child, "block-1")

	filePath := filepath.Join(nested, "live.txt")
	if err := os.WriteFile(filePath, []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	data := waitForDirWatchEvent(t, eventCh, "live.txt")
	if data.DirPath != nested {
		t.Fatalf("expected dirpath %s, got %s", nested, data.DirPath)
	}
	if data.Event != "CREATE" {
		t.Fatalf("expected CREATE event, got %s", data.Event)
	}
}

func TestDirWatchIgnoresInternalProbeFiles(t *testing.T) {
	root := t.TempDir()
	dw := newTestDirWatcher(t)
	eventCh := setupDirWatchEventCapture(t, "route-test-dirwatch-ignore-probe", "block:block-1")
	if err := dw.Subscribe(root, "block-1"); err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}

	dw.handleEvent(fsnotify.Event{Name: filepath.Join(root, "wsh-tmp-34dbe539713e"), Op: fsnotify.Create})

	assertNoDirWatchEvent(t, eventCh, 250*time.Millisecond)
}

func TestPollOncePublishesMissedDirectoryChanges(t *testing.T) {
	root := t.TempDir()
	dw := newTestDirWatcher(t)
	eventCh := setupDirWatchEventCapture(t, "route-test-dirwatch-poll-fallback", "block:block-1")
	if err := dw.Subscribe(root, "block-1"); err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}

	filePath := filepath.Join(root, "live.txt")
	if err := os.WriteFile(filePath, []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	dw.pollOnce()
	createEvent := waitForDirWatchEvent(t, eventCh, "live.txt")
	if createEvent.Event != "CREATE" {
		t.Fatalf("expected CREATE event, got %s", createEvent.Event)
	}

	if err := os.WriteFile(filePath, []byte("updated"), 0o644); err != nil {
		t.Fatalf("WriteFile update failed: %v", err)
	}

	dw.pollOnce()
	writeEvent := waitForDirWatchEvent(t, eventCh, "live.txt")
	if writeEvent.Event != "WRITE" {
		t.Fatalf("expected WRITE event, got %s", writeEvent.Event)
	}
}
