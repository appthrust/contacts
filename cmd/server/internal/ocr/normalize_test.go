package ocr

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"net/http"
	"testing"
)

func TestNormalizeLargePNG(t *testing.T) {
	for _, dimensions := range []image.Point{{X: 3000, Y: 2000}, {X: 2000, Y: 3000}} {
		source := image.NewRGBA(image.Rect(0, 0, dimensions.X, dimensions.Y))
		for y := range dimensions.Y {
			for x := range dimensions.X {
				source.SetRGBA(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 100, A: 255})
			}
		}
		var input bytes.Buffer
		if err := png.Encode(&input, source); err != nil {
			t.Fatal(err)
		}
		output, contentType, err := Normalize(input.Bytes(), "image/png")
		if err != nil {
			t.Fatal(err)
		}
		if contentType != "image/jpeg" || http.DetectContentType(output) != "image/jpeg" {
			t.Fatalf("output type=%s sniff=%s", contentType, http.DetectContentType(output))
		}
		config, err := jpeg.DecodeConfig(bytes.NewReader(output))
		if err != nil {
			t.Fatal(err)
		}
		longEdge := max(dimensions.X, dimensions.Y)
		if config.Width != dimensions.X*1600/longEdge || config.Height != dimensions.Y*1600/longEdge {
			t.Fatalf("got %dx%d for %v", config.Width, config.Height, dimensions)
		}
	}
}

func TestNormalizeSmallJPEG(t *testing.T) {
	var input bytes.Buffer
	if err := jpeg.Encode(&input, image.NewRGBA(image.Rect(0, 0, 80, 40)), &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	// The actual JPEG wins over an incorrect declared PNG or passthrough type.
	for _, declared := range []string{"image/jpeg", "image/png", "image/webp", "application/octet-stream"} {
		output, contentType, err := Normalize(input.Bytes(), declared)
		if err != nil {
			t.Fatal(err)
		}
		config, err := jpeg.DecodeConfig(bytes.NewReader(output))
		if err != nil || contentType != "image/jpeg" || config.Width != 80 || config.Height != 40 {
			t.Fatalf("declared=%s type=%s config=%+v error=%v", declared, contentType, config, err)
		}
	}
}

func TestNormalizeUnsupported(t *testing.T) {
	var input bytes.Buffer
	if err := gif.Encode(&input, image.NewPaletted(image.Rect(0, 0, 10, 10), color.Palette{color.Black}), nil); err != nil {
		t.Fatal(err)
	}
	for _, declared := range []string{"image/gif", "image/jpeg", "image/webp"} {
		if _, _, err := Normalize(input.Bytes(), declared); !errors.Is(err, ErrUnsupported) {
			t.Errorf("declared=%s error=%v, want ErrUnsupported", declared, err)
		}
	}
	if _, _, err := Normalize([]byte("not an image"), "text/plain"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("text error=%v", err)
	}
}

func TestNormalizePassthrough(t *testing.T) {
	for _, contentType := range []string{"image/webp", "image/heic", "image/heif"} {
		input := []byte("encoded image not supported by the stdlib decoder")
		output, outputType, err := Normalize(input, contentType)
		if err != nil || outputType != contentType || !bytes.Equal(output, input) || &output[0] != &input[0] {
			t.Errorf("type=%s outputType=%s error=%v, expected unchanged bytes without a copy", contentType, outputType, err)
		}
	}
}

func TestNormalizeCorruptImage(t *testing.T) {
	for _, input := range [][]byte{[]byte("\x89PNG\r\n\x1a\ntruncated"), {0xff, 0xd8, 0xff, 0x00}} {
		if _, _, err := Normalize(input, "image/jpeg"); err == nil {
			t.Error("corrupt image accepted")
		}
	}
}

func TestBoxDownscaleAveragesPixels(t *testing.T) {
	source := image.NewRGBA(image.Rect(10, 20, 12, 22))
	source.SetRGBA(10, 20, color.RGBA{R: 255, A: 255})
	source.SetRGBA(11, 20, color.RGBA{G: 255, A: 255})
	source.SetRGBA(10, 21, color.RGBA{B: 255, A: 255})
	source.SetRGBA(11, 21, color.RGBA{R: 255, G: 255, B: 255, A: 255})
	output := boxDownscale(source, 1, 1)
	if got := output.RGBAAt(0, 0); got != (color.RGBA{R: 127, G: 127, B: 127, A: 255}) {
		t.Fatalf("box average=%v", got)
	}
}
