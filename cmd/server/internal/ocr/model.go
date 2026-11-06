package ocr

import "sync/atomic"

// ModelSelector shares the current Project override across OCR requests.
// An empty override restores the release default; both empty use gateway policy.
// A selector must not be copied after first use.
type ModelSelector struct {
	release  string
	override atomic.Value
}

func NewModelSelector(release string) *ModelSelector {
	return &ModelSelector{release: release}
}

func (s *ModelSelector) Set(override string) {
	s.override.Store(override)
}

func (s *ModelSelector) Current() string {
	if s == nil {
		return ""
	}
	if override, ok := s.override.Load().(string); ok && override != "" {
		return override
	}
	return s.release
}
