package ocr

import (
	"reflect"
	"testing"
)

func TestFilterRegions(t *testing.T) {
	left := Region{0, 0, 200, 200}
	right := Region{600, 0, 800, 200}
	for _, tc := range []struct {
		name          string
		width, height int
		regions       []Region
		want          []Region
	}{
		{"empty", 1000, 1000, nil, nil},
		{"single region", 1000, 1000, []Region{left}, nil},
		{"invalid dimensions", 1000, 0, []Region{left, right}, nil},
		{"exactly four percent", 1000, 1000, []Region{right, left}, []Region{left, right}},
		{"below four percent", 1000, 1000, []Region{left, {600, 0, 799, 200}}, nil},
		{"clamp before filtering", 1000, 1000, []Region{{-100, -100, 200, 200}, {800, 800, 1100, 1100}}, []Region{left, {800, 800, 1000, 1000}}},
		{"clamping shrinks area", 1000, 1000, []Region{left, {-100, 600, 100, 800}}, nil},
		{"zero and inverted boxes", 1000, 1000, []Region{left, right, {0, 0, 0, 400}, {800, 800, 600, 600}}, []Region{left, right}},
		{"aspect boundaries", 1000, 1000, []Region{{0, 0, 500, 200}, {600, 0, 800, 500}}, []Region{{0, 0, 500, 200}, {600, 0, 800, 500}}},
		{"aspect outside boundaries", 1000, 1000, []Region{left, right, {0, 500, 501, 700}, {600, 500, 800, 1001}}, []Region{left, right, {600, 500, 800, 1000}}},
		{"too tall", 1000, 1000, []Region{left, {600, 0, 800, 501}}, nil},
		{"deduplicate keeping larger", 1000, 1000, []Region{left, {0, 0, 250, 250}, right}, []Region{{0, 0, 250, 250}, right}},
		{"deduplicate independent of input order", 1000, 1000, []Region{right, {0, 0, 250, 250}, left}, []Region{{0, 0, 250, 250}, right}},
		{"IoU exactly one half remains", 1000, 1000, []Region{{0, 0, 300, 200}, {100, 0, 400, 200}}, []Region{{0, 0, 300, 200}, {100, 0, 400, 200}}},
		{"IoU above one half removed", 1000, 1000, []Region{{0, 0, 300, 200}, {99, 0, 399, 200}}, nil},
		{"eighty percent is single card", 1000, 1000, []Region{{0, 0, 1000, 800}, right}, nil},
		{"below eighty percent can split", 1000, 1000, []Region{{0, 0, 1000, 799}, right}, []Region{{0, 0, 1000, 799}, right}},
		{"small row bucket", 10, 5, []Region{{5, 0, 9, 2}, {0, 0, 4, 2}}, []Region{{0, 0, 4, 2}, {5, 0, 9, 2}}},
		{
			"two columns three rows with jitter", 1000, 1000,
			[]Region{{550, 725, 950, 925}, {550, 35, 950, 235}, {50, 395, 450, 595}, {50, 745, 450, 945}, {550, 375, 950, 575}, {50, 55, 450, 255}},
			[]Region{{50, 55, 450, 255}, {550, 35, 950, 235}, {50, 395, 450, 595}, {550, 375, 950, 575}, {50, 745, 450, 945}, {550, 725, 950, 925}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := FilterRegions(tc.regions, tc.width, tc.height); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("regions = %v, want %v", got, tc.want)
			}
		})
	}
}
