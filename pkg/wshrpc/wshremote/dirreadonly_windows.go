//go:build windows

package wshremote

import (
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

func checkDirIsReadOnly(dirPath string) bool {
	randHexStr, err := utilfn.RandomHexString(12)
	if err != nil {
		// we're not sure, just return false
		return false
	}
	tmpFileName := filepath.Join(dirPath, "wsh-tmp-"+randHexStr)
	fd, err := os.Create(tmpFileName)
	if err != nil {
		return true
	}
	utilfn.GracefulClose(fd, "checkDirIsReadOnly", tmpFileName)
	_ = os.Remove(tmpFileName)
	return false
}
