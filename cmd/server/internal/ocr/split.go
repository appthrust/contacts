package ocr

import "context"

// Region is one detected business card in pixel coordinates of the normalised
// upload image (x1,y1 top-left inclusive; x2,y2 bottom-right exclusive).
type Region struct{ X1, Y1, X2, Y2 int }

// Splitter locates business cards in an image that may contain several. It
// holds no Project credential; the uploader's bearer authorises the call.
type Splitter interface {
	Name() string
	Split(ctx context.Context, image []byte, contentType string, width, height int, authorization string) ([]Region, error)
}
