package ocr

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"strings"
)

var ErrUnsupported = errors.New("unsupported image")

// Normalize re-encodes JPEG and PNG as JPEG at quality 85, shrinking images to
// a long edge of at most 1600 pixels without upscaling. EXIF orientation is not
// applied; re-encoding removes the original metadata. WebP, HEIC and HEIF are
// passed through without decoding, resizing or copying because the standard
// library has no decoder for them. A recognizable signature wins over the
// declared type; otherwise those passthrough formats trust the declaration.
func Normalize(input []byte, contentType string) (out []byte, outType string, err error) {
	declared, _, _ := strings.Cut(contentType, ";")
	contentType = strings.ToLower(strings.TrimSpace(declared))
	sniffed := http.DetectContentType(input)
	if sniffed != "application/octet-stream" && !strings.HasPrefix(sniffed, "text/plain") {
		contentType = sniffed
	}
	var decoded image.Image
	switch contentType {
	case "image/webp", "image/heic", "image/heif":
		return input, contentType, nil
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
	bounds := decoded.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if longEdge := max(width, height); longEdge > 1600 {
		decoded = boxDownscale(decoded, max(1, width*1600/longEdge), max(1, height*1600/longEdge))
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, decoded, &jpeg.Options{Quality: 85}); err != nil {
		return nil, "", fmt.Errorf("encode card image: %w", err)
	}
	return encoded.Bytes(), "image/jpeg", nil
}

// boxDownscale averages the disjoint source pixel boxes covered by each output
// pixel. Each source pixel is sampled once, with no intermediate full-size copy.
func boxDownscale(source image.Image, width, height int) *image.RGBA {
	bounds := source.Bounds()
	pixel := func(x, y int) (uint32, uint32, uint32) {
		r, g, b, _ := source.At(x, y).RGBA()
		return r, g, b
	}
	if source64, ok := source.(image.RGBA64Image); ok {
		// Standard JPEG/PNG images expose RGBA64At, avoiding an interface-boxed
		// color allocation for every sampled pixel.
		pixel = func(x, y int) (uint32, uint32, uint32) {
			c := source64.RGBA64At(x, y)
			return uint32(c.R), uint32(c.G), uint32(c.B)
		}
	}
	out := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		y0 := bounds.Min.Y + y*bounds.Dy()/height
		y1 := bounds.Min.Y + (y+1)*bounds.Dy()/height
		for x := range width {
			x0 := bounds.Min.X + x*bounds.Dx()/width
			x1 := bounds.Min.X + (x+1)*bounds.Dx()/width
			var red, green, blue uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					r, g, b := pixel(sx, sy)
					red += uint64(r)
					green += uint64(g)
					blue += uint64(b)
				}
			}
			count := uint64(x1-x0) * uint64(y1-y0)
			offset := y*out.Stride + x*4
			out.Pix[offset] = uint8((red / count) >> 8)
			out.Pix[offset+1] = uint8((green / count) >> 8)
			out.Pix[offset+2] = uint8((blue / count) >> 8)
			out.Pix[offset+3] = 255
		}
	}
	return out
}
