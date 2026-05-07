package fileutil

import "testing"

func TestIsInternalTempProbeFileName(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{name: "wsh-tmp-34dbe539713e", want: true},
		{name: "wsh-tmp-ABCDEF123456", want: true},
		{name: "wsh-tmp-123", want: false},
		{name: "wsh-tmp-34dbe539713e.txt", want: false},
		{name: "notes.txt", want: false},
	}

	for _, test := range tests {
		if got := IsInternalTempProbeFileName(test.name); got != test.want {
			t.Fatalf("IsInternalTempProbeFileName(%q) = %v, want %v", test.name, got, test.want)
		}
	}
}
