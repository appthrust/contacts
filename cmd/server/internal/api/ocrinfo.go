package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// OCRInfo describes the configured extractor without exposing gateway credentials.
type OCRInfo struct {
	Available    bool
	Extractor    string
	ReleaseModel string
	SheetSplit   bool
	Probe        func(context.Context, string) OCRModelInfo
}

type OCRModel struct {
	ID      string `json:"id"`
	OwnedBy string `json:"ownedBy"`
	Local   bool   `json:"local"`
}

// OCRModelInfo is one consistent snapshot of the effective model and its catalog.
type OCRModelInfo struct {
	Model  string     `json:"model"`
	Local  bool       `json:"local"`
	Models []OCRModel `json:"models"`
}

type localityKey struct {
	bearer [sha256.Size]byte
	model  string
}

type localityEntry struct {
	info    OCRModelInfo
	expires time.Time
}

// NewOCRLocalProbe reports model locality and available models using the caller's
// gateway authority. Cache keys contain bearer digests, never credentials, and
// the effective model so Settings changes take effect without waiting for expiry.
func NewOCRLocalProbe(origin string, model func() string, client *http.Client) func(context.Context, string) OCRModelInfo {
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	endpoint := strings.TrimRight(origin, "/") + "/v1/models"
	var mu sync.Mutex
	cache := make(map[localityKey]localityEntry)
	return func(ctx context.Context, bearer string) OCRModelInfo {
		info := OCRModelInfo{Models: []OCRModel{}}
		if model != nil {
			info.Model = model()
		}
		if origin == "" || bearer == "" {
			return info
		}
		key := localityKey{bearer: sha256.Sum256([]byte(bearer)), model: info.Model}
		mu.Lock()
		now := time.Now()
		if entry, ok := cache[key]; ok && now.Before(entry.expires) {
			mu.Unlock()
			return entry.info
		}
		for key, entry := range cache {
			if !now.Before(entry.expires) {
				delete(cache, key)
			}
		}
		mu.Unlock()

		info.Models = probeModels(ctx, client, endpoint, bearer)
		for _, entry := range info.Models {
			if info.Model == "" || entry.ID == info.Model {
				info.Local = entry.Local
				break
			}
		}
		mu.Lock()
		cache[key] = localityEntry{info: info, expires: time.Now().Add(time.Minute)}
		mu.Unlock()
		return info
	}
}

func probeModels(ctx context.Context, client *http.Client, endpoint, bearer string) []OCRModel {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	empty := []OCRModel{}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return empty
	}
	req.Header.Set("Authorization", bearer)
	res, err := client.Do(req)
	if err != nil {
		return empty
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return empty
	}
	var models struct {
		Data []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&models); err != nil {
		return empty
	}
	out := make([]OCRModel, len(models.Data))
	for i, entry := range models.Data {
		out[i] = OCRModel{ID: entry.ID, OwnedBy: entry.OwnedBy, Local: entry.OwnedBy != "openai" && entry.OwnedBy != "anthropic"}
	}
	return out
}
