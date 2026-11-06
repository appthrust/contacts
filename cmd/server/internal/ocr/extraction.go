package ocr

import (
	"context"
	"time"
)

// Extraction is one immutable reading of a card by one engine. A re-run adds a
// new Extraction; nothing updates an existing one. ID and CreatedAt are set by
// the store when the row is written.
type Extraction struct {
	ID              string             `json:"id"`
	Engine          string             `json:"engine"`
	Model           string             `json:"model"`
	Fields          Fields             `json:"fields"`
	FieldConfidence map[string]float64 `json:"fieldConfidence"`
	Overall         float64            `json:"overall"`
	DurationMs      int64              `json:"durationMs"`
	CreatedAt       time.Time          `json:"createdAt"`
}

// Extractor turns a card image into an Extraction using the caller's bearer.
// Implementations hold no Project credential (gateway AI5); an empty
// authorization yields ErrUnavailable without a network call.
type Extractor interface {
	Name() string
	Extract(ctx context.Context, image []byte, contentType, authorization string) (Extraction, error)
}

// Engine names.
const (
	EngineGatewayVision = "gateway-vision"
)
