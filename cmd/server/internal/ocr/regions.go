package ocr

import (
	"cmp"
	"slices"
)

// FilterRegions clamps, filters and deduplicates regions in place. It returns
// nil when the original image should remain one card, otherwise regions ordered
// by 10%-height row bucket and then left edge.
func FilterRegions(regions []Region, width, height int) []Region {
	if width <= 0 || height <= 0 {
		return nil
	}
	imageArea := float64(width) * float64(height)
	kept := regions[:0]
	for _, r := range regions {
		r = clampRegion(r, width, height)
		w, h := r.X2-r.X1, r.Y2-r.Y1
		if w <= 0 || h <= 0 || regionArea(r)*25 < imageArea {
			continue
		}
		aspect := float64(w) / float64(h)
		if aspect < 1/2.5 || aspect > 2.5 {
			continue
		}
		if regionArea(r)*5 >= imageArea*4 {
			return nil
		}
		kept = append(kept, r)
	}
	// Largest first ensures an overlapping smaller detection cannot displace it.
	slices.SortStableFunc(kept, func(a, b Region) int {
		return cmp.Compare(regionArea(b), regionArea(a))
	})
	deduplicated := kept[:0]
	for _, r := range kept {
		duplicate := false
		for _, previous := range deduplicated {
			intersection := float64(max(0, min(r.X2, previous.X2)-max(r.X1, previous.X1))) *
				float64(max(0, min(r.Y2, previous.Y2)-max(r.Y1, previous.Y1)))
			if intersection*2 > regionArea(r)+regionArea(previous)-intersection {
				duplicate = true
				break
			}
		}
		if !duplicate {
			deduplicated = append(deduplicated, r)
		}
	}
	if len(deduplicated) < 2 {
		return nil
	}
	rowHeight := max(1, height/10)
	slices.SortFunc(deduplicated, func(a, b Region) int {
		if row := cmp.Compare(a.Y1/rowHeight, b.Y1/rowHeight); row != 0 {
			return row
		}
		if x := cmp.Compare(a.X1, b.X1); x != 0 {
			return x
		}
		if y := cmp.Compare(a.Y1, b.Y1); y != 0 {
			return y
		}
		if x := cmp.Compare(a.X2, b.X2); x != 0 {
			return x
		}
		return cmp.Compare(a.Y2, b.Y2)
	})
	return deduplicated
}

func clampRegion(r Region, width, height int) Region {
	return Region{
		X1: max(0, min(width, r.X1)),
		Y1: max(0, min(height, r.Y1)),
		X2: max(0, min(width, r.X2)),
		Y2: max(0, min(height, r.Y2)),
	}
}

func regionArea(r Region) float64 {
	return float64(r.X2-r.X1) * float64(r.Y2-r.Y1)
}
