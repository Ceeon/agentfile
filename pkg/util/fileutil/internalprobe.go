// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package fileutil

import "regexp"

var internalTempProbeNameRe = regexp.MustCompile(`^wsh-tmp-[0-9a-fA-F]{12,}$`)

func IsInternalTempProbeFileName(name string) bool {
	return internalTempProbeNameRe.MatchString(name)
}
