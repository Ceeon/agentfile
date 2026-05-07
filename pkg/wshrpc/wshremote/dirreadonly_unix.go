//go:build !windows

package wshremote

import "golang.org/x/sys/unix"

func checkDirIsReadOnly(dirPath string) bool {
	return unix.Access(dirPath, unix.W_OK|unix.X_OK) != nil
}
