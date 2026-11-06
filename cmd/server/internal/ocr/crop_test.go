package ocr

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"testing"
)

func TestDecode(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 320, 180))
	for _, contentType := range []string{"image/png", "image/jpeg"} {
		t.Run(contentType, func(t *testing.T) {
			input := encodeCropImage(t, source, contentType)
			width, height, err := Decode(input, contentType)
			if err != nil || width != 320 || height != 180 {
				t.Fatalf("dimensions=%dx%d error=%v", width, height, err)
			}
		})
	}
}

func TestCrop(t *testing.T) {
	for _, tc := range []struct {
		name        string
		contentType string
		size        image.Point
		region      Region
		want        image.Point
	}{
		{"PNG crop", "image/png", image.Pt(400, 300), Region{40, 70, 240, 170}, image.Pt(200, 100)},
		{"JPEG crop", "image/jpeg", image.Pt(400, 300), Region{40, 70, 240, 170}, image.Pt(200, 100)},
		{"clamp", "image/png", image.Pt(400, 300), Region{-20, 70, 450, 350}, image.Pt(400, 230)},
		{"landscape downscale", "image/png", image.Pt(2500, 1500), Region{100, 200, 2100, 1200}, image.Pt(1600, 800)},
		{"portrait downscale", "image/png", image.Pt(1500, 2500), Region{200, 100, 1200, 2100}, image.Pt(800, 1600)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := image.NewRGBA(image.Rect(0, 0, tc.size.X, tc.size.Y))
			for y := range tc.size.Y {
				for x := range tc.size.X {
					source.SetRGBA(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 100, A: 255})
				}
			}
			input := encodeCropImage(t, source, tc.contentType)
			output, contentType, err := Crop(input, tc.contentType, tc.region)
			if err != nil {
				t.Fatal(err)
			}
			if contentType != "image/jpeg" || http.DetectContentType(output) != "image/jpeg" {
				t.Fatalf("output type=%s sniff=%s", contentType, http.DetectContentType(output))
			}
			config, err := jpeg.DecodeConfig(bytes.NewReader(output))
			if err != nil || config.Width != tc.want.X || config.Height != tc.want.Y {
				t.Fatalf("dimensions=%dx%d error=%v, want %v", config.Width, config.Height, err, tc.want)
			}
			if tc.contentType != "image/png" {
				return
			}
			// The crop must use the same resize and q85 encoding as Normalize,
			// including a nonzero source origin, without a lossy intermediate JPEG.
			decoded, _, err := image.Decode(bytes.NewReader(input))
			if err != nil {
				t.Fatal(err)
			}
			r := tc.region
			cropped := decoded.(interface {
				SubImage(image.Rectangle) image.Image
			}).SubImage(image.Rect(r.X1, r.Y1, r.X2, r.Y2))
			want, _, err := Normalize(encodeCropImage(t, cropped, "image/png"), "image/png")
			if err != nil || !bytes.Equal(output, want) {
				t.Fatalf("crop differs from Normalize JPEG path: error=%v", err)
			}
		})
	}
}

func TestCropUnsupportedAndInvalid(t *testing.T) {
	for _, contentType := range []string{"image/webp", "image/heic", "image/heif", "image/gif", "text/plain"} {
		if _, _, err := Decode(nil, contentType); !errors.Is(err, ErrUnsupported) {
			t.Errorf("Decode(%s) error=%v, want ErrUnsupported", contentType, err)
		}
		if _, _, err := Crop(nil, contentType, Region{}); !errors.Is(err, ErrUnsupported) {
			t.Errorf("Crop(%s) error=%v, want ErrUnsupported", contentType, err)
		}
	}
	for _, contentType := range []string{"image/png", "image/jpeg"} {
		if _, _, err := Decode([]byte("corrupt image"), contentType); err == nil {
			t.Errorf("Decode(%s) accepted corrupt image", contentType)
		}
		if _, _, err := Crop([]byte("corrupt image"), contentType, Region{}); err == nil {
			t.Errorf("Crop(%s) accepted corrupt image", contentType)
		}
	}
	input := encodeCropImage(t, image.NewRGBA(image.Rect(0, 0, 20, 20)), "image/png")
	for _, region := range []Region{{0, 0, 0, 10}, {15, 15, 5, 5}, {30, 30, 40, 40}} {
		if _, _, err := Crop(input, "image/png", region); err == nil || err.Error() != "empty card crop" {
			t.Errorf("Crop(%v) error=%v, want empty card crop", region, err)
		}
	}
}

func encodeCropImage(t *testing.T, source image.Image, contentType string) []byte {
	t.Helper()
	var encoded bytes.Buffer
	var err error
	if contentType == "image/jpeg" {
		err = jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 95})
	} else {
		err = png.Encode(&encoded, source)
	}
	if err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}
