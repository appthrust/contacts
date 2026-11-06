package ocr

// Select returns the first preferred extractor that is available. An empty
// preference accepts any extractor, in available order.
func Select(preference []string, available []Extractor) Extractor {
	if len(preference) == 0 {
		for _, extractor := range available {
			if extractor != nil {
				return extractor
			}
		}
		return nil
	}
	for _, name := range preference {
		for _, extractor := range available {
			if extractor != nil && extractor.Name() == name {
				return extractor
			}
		}
	}
	return nil
}
