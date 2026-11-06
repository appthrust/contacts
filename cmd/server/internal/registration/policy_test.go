package registration

import (
	"math"
	"strings"
	"testing"

	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/resolve"
	"github.com/stretchr/testify/require"
)

func TestDecide(t *testing.T) {
	for _, tc := range []struct {
		name          string
		mode          Mode
		fields        ocr.Fields
		overall       float64
		required      []string
		candidates    []resolve.Candidate
		linkThreshold float64
		want          Decision
	}{
		{name: "off precedes missing fields", mode: ModeOff, want: Decision{Kind: Unavailable}},
		{name: "review precedes missing fields", mode: ModeReview, want: Decision{Kind: NeedsReview, Reason: "policy"}},
		{name: "missing required field precedes email", fields: ocr.Fields{FullName: "  "}, overall: 1, candidates: []resolve.Candidate{{ContactID: "email", Score: 1, Reason: "email"}}, want: Decision{Kind: NeedsReview, Reason: "missing_field:fullName"}},
		{name: "email links despite low extraction confidence", fields: ocr.Fields{FullName: "Name"}, candidates: []resolve.Candidate{{ContactID: "email", Score: 1, Reason: "email"}}, want: Decision{Kind: AutoLinked, ContactID: "email"}},
		{name: "name company threshold inclusive", fields: ocr.Fields{FullName: "Name"}, linkThreshold: .95, candidates: []resolve.Candidate{{ContactID: "company", Score: .95, Reason: "name_company"}}, want: Decision{Kind: AutoLinked, ContactID: "company"}},
		{name: "strong match below configured threshold", fields: ocr.Fields{FullName: "Name"}, overall: 1, linkThreshold: 1, candidates: []resolve.Candidate{{ContactID: "company", Score: .95, Reason: "name_company"}}, want: Decision{Kind: NeedsReview, Reason: "ambiguous_match"}},
		{name: "name only never links even with low threshold", fields: ocr.Fields{FullName: "Name"}, overall: 1, linkThreshold: .5, candidates: []resolve.Candidate{{ContactID: "name", Score: .6, Reason: "name"}}, want: Decision{Kind: NeedsReview, Reason: "ambiguous_match"}},
		{name: "any ambiguous candidate", fields: ocr.Fields{FullName: "Name"}, overall: 1, candidates: []resolve.Candidate{{Score: .5}, {Score: .6}}, want: Decision{Kind: NeedsReview, Reason: "ambiguous_match"}},
		{name: "only best candidate can link", fields: ocr.Fields{FullName: "Name"}, overall: 1, candidates: []resolve.Candidate{{Score: 1, Reason: "name"}, {Score: .95, Reason: "email"}}, want: Decision{Kind: NeedsReview, Reason: "ambiguous_match"}},
		{name: "creation threshold inclusive", fields: ocr.Fields{FullName: "Name"}, overall: .85, want: Decision{Kind: AutoCreated}},
		{name: "weak candidate allows creation", fields: ocr.Fields{FullName: "Name"}, overall: .9, candidates: []resolve.Candidate{{Score: .59, Reason: "name"}}, want: Decision{Kind: AutoCreated}},
		{name: "low confidence", fields: ocr.Fields{FullName: "Name"}, overall: .849, want: Decision{Kind: NeedsReview, Reason: "low_confidence"}},
		{name: "empty arrays are missing", fields: ocr.Fields{FullName: "Name", Emails: []string{"  "}}, required: []string{"emails"}, overall: 1, want: Decision{Kind: NeedsReview, Reason: "missing_field:emails"}},
		{name: "present arrays", fields: ocr.Fields{FullName: "Name", Phones: []string{"", "123"}}, required: []string{"phones"}, overall: 1, want: Decision{Kind: AutoCreated}},
		{name: "required field ordering", fields: ocr.Fields{FullName: "Name"}, required: []string{"company", "emails"}, overall: 1, want: Decision{Kind: NeedsReview, Reason: "missing_field:company"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := Defaults()
			if tc.mode != "" {
				s.Mode = tc.mode
			}
			if tc.required != nil {
				s.RequiredFields = tc.required
			}
			if tc.linkThreshold != 0 {
				s.AutoLinkThreshold = tc.linkThreshold
			}
			require.Equal(t, tc.want, Decide(s, ocr.Extraction{Fields: tc.fields, Overall: tc.overall}, resolve.Resolution{Contacts: tc.candidates}))
		})
	}
}

func TestValidateSettings(t *testing.T) {
	require.NoError(t, Validate(Defaults()))
	for _, tc := range []struct {
		name      string
		change    func(*Settings)
		errorText string
	}{
		{"mode", func(s *Settings) { s.Mode = "invalid" }, "mode must be auto, review, or off"},
		{"negative", func(s *Settings) { s.AutoCreateThreshold = -.1 }, "autoCreateThreshold must be between 0 and 1"},
		{"large", func(s *Settings) { s.AutoLinkThreshold = 1.1 }, "autoLinkThreshold must be between 0 and 1"},
		{"nan", func(s *Settings) { s.AutoCreateThreshold = math.NaN() }, "autoCreateThreshold must be between 0 and 1"},
		{"infinity", func(s *Settings) { s.AutoLinkThreshold = math.Inf(1) }, "autoLinkThreshold must be between 0 and 1"},
		{"field", func(s *Settings) { s.RequiredFields = []string{"notAField"} }, "unknown required field: notAField"},
		{"extractor", func(s *Settings) { s.ExtractorPreference = []string{" "} }, "extractorPreference entries must not be empty"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := Defaults()
			tc.change(&s)
			require.EqualError(t, Validate(s), tc.errorText)
		})
	}
	s := Defaults()
	s.AutoCreateThreshold, s.AutoLinkThreshold = 0, 1
	s.RequiredFields = []string{"fullName", "kana", "company", "department", "title", "emails", "phones", "address", "url", "confidence"}
	s.ExtractorPreference = []string{}
	require.NoError(t, Validate(s))
}

func TestValidateOCRModel(t *testing.T) {
	for _, model := range []string{"", "gemma3:4b", "gpt-5-mini", "qwen3-vl-4b-instruct-fp8", strings.Repeat("a", 128), strings.Repeat("界", 128)} {
		s := Defaults()
		s.OCRModel = model
		require.NoError(t, Validate(s))
	}
	for _, model := range []string{" gpt", "gpt ", "gpt mini", "gpt\tmini", "gpt\nmini", "gpt\rmini", "gpt\u00a0mini", "gpt\u3000mini", "gpt\x00mini", "gpt\x7fmini", "gpt\u0085mini"} {
		s := Defaults()
		s.OCRModel = model
		require.EqualError(t, Validate(s), "ocrModel must not contain whitespace or control characters")
	}
	for _, model := range []string{strings.Repeat("a", 129), strings.Repeat("界", 129)} {
		s := Defaults()
		s.OCRModel = model
		require.EqualError(t, Validate(s), "ocrModel must be at most 128 characters")
	}
}
