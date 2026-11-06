package ocr

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
)

// Decode reads JPEG or PNG dimensions without decoding the image's pixels.
// Other formats return ErrUnsupported, including Normalize's passthrough types.
func Decode(input []byte, contentType string) (width, height int, err error) {
	var config image.Config
	switch contentType {
	case "image/jpeg":
		config, err = jpeg.DecodeConfig(bytes.NewReader(input))
	case "image/png":
		config, err = png.DecodeConfig(bytes.NewReader(input))
	default:
		return 0, 0, ErrUnsupported
	}
	if err != nil {
		return 0, 0, fmt.Errorf("decode card image: %w", err)
	}
	return config.Width, config.Height, nil
}

// Crop clamps a JPEG/PNG region to the image and encodes it with Normalize's
// box resize and JPEG settings (long edge <=1600 pixels, quality 85).
func Crop(input []byte, contentType string, r Region) (out []byte, outType string, err error) {
	var decoded image.Image
	switch contentType {
	case "image/jpeg":
		decoded, err = jpeg.Decode(bytes.NewReader(input))
	case "image/png":
		decoded, err = png.Decode(bytes.NewReader(input))
	default:
		return nil, "", ErrUnsupported
	}
	if err != nil {
		return nil, "", fmt.Errorf("decode card image: %w", err)
	}
	r = clampRegion(r, decoded.Bounds().Dx(), decoded.Bounds().Dy())
	if r.X2 <= r.X1 || r.Y2 <= r.Y1 {
		return nil, "", errors.New("empty card crop")
	}
	// All standard JPEG/PNG decoder image types implement SubImage. This view
	// shares the decoded pixels instead of copying the full crop.
	decoded = decoded.(interface {
		SubImage(image.Rectangle) image.Image
	}).SubImage(image.Rect(r.X1, r.Y1, r.X2, r.Y2))
	width, height := r.X2-r.X1, r.Y2-r.Y1
	if longEdge := max(width, height); longEdge > 1600 {
		decoded = boxDownscale(decoded, max(1, width*1600/longEdge), max(1, height*1600/longEdge))
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, decoded, &jpeg.Options{Quality: 85}); err != nil {
		return nil, "", fmt.Errorf("encode card image: %w", err)
	}
	return encoded.Bytes(), "image/jpeg", nil
}
