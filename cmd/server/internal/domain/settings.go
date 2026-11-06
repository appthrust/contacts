package domain

import "github.com/appthrust/contacts/cmd/server/internal/ocr"

// RegistrationMode and RegistrationSettings are shared by persistence and policy
// so the registrar can depend on the store without a package cycle.
type RegistrationMode string

type RegistrationSettings struct {
	Mode                RegistrationMode `json:"mode"`
	AutoCreateThreshold float64          `json:"autoCreateThreshold"`
	AutoLinkThreshold   float64          `json:"autoLinkThreshold"`
	RequiredFields      []string         `json:"requiredFields"`
	PrivateDefault      bool             `json:"privateDefault"`
	ExtractorPreference []string         `json:"extractorPreference"`
	OCRModel            string           `json:"ocrModel"`
}

func DefaultRegistrationSettings() RegistrationSettings {
	return RegistrationSettings{
		Mode: "auto", AutoCreateThreshold: 0.85, AutoLinkThreshold: 0.9,
		RequiredFields:      []string{"fullName"},
		ExtractorPreference: []string{ocr.EngineGatewayVision},
	}
}
