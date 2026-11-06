package registration

import (
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/resolve"
)

type Mode = domain.RegistrationMode
type Settings = domain.RegistrationSettings

const (
	ModeAuto   Mode = "auto"
	ModeReview Mode = "review"
	ModeOff    Mode = "off"
)

func Defaults() Settings { return domain.DefaultRegistrationSettings() }

type DecisionKind string

const (
	AutoCreated DecisionKind = "AutoCreated"
	AutoLinked  DecisionKind = "AutoLinked"
	NeedsReview DecisionKind = "NeedsReview"
	Unavailable DecisionKind = "Unavailable"
)

type Decision struct {
	Kind      DecisionKind
	Reason    string
	ContactID string
}

func Validate(s Settings) error {
	switch s.Mode {
	case ModeAuto, ModeReview, ModeOff:
	default:
		return fmt.Errorf("mode must be auto, review, or off")
	}
	for _, threshold := range []struct {
		name  string
		value float64
	}{{"autoCreateThreshold", s.AutoCreateThreshold}, {"autoLinkThreshold", s.AutoLinkThreshold}} {
		if math.IsNaN(threshold.value) || threshold.value < 0 || threshold.value > 1 {
			return fmt.Errorf("%s must be between 0 and 1", threshold.name)
		}
	}
	for _, field := range s.RequiredFields {
		switch field {
		case "fullName", "kana", "company", "department", "title", "emails", "phones", "address", "url", "confidence":
		default:
			return fmt.Errorf("unknown required field: %s", field)
		}
	}
	for _, name := range s.ExtractorPreference {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("extractorPreference entries must not be empty")
		}
	}
	if utf8.RuneCountInString(s.OCRModel) > 128 {
		return fmt.Errorf("ocrModel must be at most 128 characters")
	}
	for _, r := range s.OCRModel {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return fmt.Errorf("ocrModel must not contain whitespace or control characters")
		}
	}
	return nil
}

// Decide follows policy order: mode, required fields, strong link, ambiguous
// candidate, then creation confidence. Name-only matches can never auto-link.
func Decide(s Settings, x ocr.Extraction, r resolve.Resolution) Decision {
	if s.Mode == ModeOff {
		return Decision{Kind: Unavailable}
	}
	if s.Mode == ModeReview {
		return Decision{Kind: NeedsReview, Reason: "policy"}
	}
	for _, name := range s.RequiredFields {
		if !fieldPresent(x.Fields, name) {
			return Decision{Kind: NeedsReview, Reason: "missing_field:" + name}
		}
	}
	if len(r.Contacts) > 0 {
		best := r.Contacts[0]
		if best.Score >= s.AutoLinkThreshold && (best.Reason == "email" || best.Reason == "name_company") {
			return Decision{Kind: AutoLinked, ContactID: best.ContactID}
		}
	}
	for _, candidate := range r.Contacts {
		if candidate.Score >= 0.6 {
			return Decision{Kind: NeedsReview, Reason: "ambiguous_match"}
		}
	}
	if x.Overall >= s.AutoCreateThreshold {
		return Decision{Kind: AutoCreated}
	}
	return Decision{Kind: NeedsReview, Reason: "low_confidence"}
}

func fieldPresent(f ocr.Fields, name string) bool {
	var scalar string
	switch name {
	case "fullName":
		scalar = f.FullName
	case "kana":
		scalar = f.Kana
	case "company":
		scalar = f.Company
	case "department":
		scalar = f.Department
	case "title":
		scalar = f.Title
	case "address":
		scalar = f.Address
	case "url":
		scalar = f.URL
	case "confidence":
		return f.Confidence > 0
	case "emails", "phones":
		values := f.Emails
		if name == "phones" {
			values = f.Phones
		}
		for _, value := range values {
			if strings.TrimSpace(value) != "" {
				return true
			}
		}
		return false
	default:
		return false
	}
	return strings.TrimSpace(scalar) != ""
}
