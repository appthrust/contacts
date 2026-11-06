package ocr

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestModelSelector(t *testing.T) {
	for _, release := range []string{"", "gemma3:4b"} {
		model := NewModelSelector(release)
		require.Equal(t, release, model.Current())
		model.Set("gpt-5-mini")
		require.Equal(t, "gpt-5-mini", model.Current())
		model.Set("qwen3-vl-4b-instruct-fp8")
		require.Equal(t, "qwen3-vl-4b-instruct-fp8", model.Current())
		model.Set("")
		require.Equal(t, release, model.Current())
	}
	var model *ModelSelector
	require.Empty(t, model.Current())
	var zero ModelSelector
	require.Empty(t, zero.Current())
}

func TestModelSelectorConcurrent(t *testing.T) {
	model := NewModelSelector("release")
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			for range 1000 {
				model.Set("override")
				if current := model.Current(); current != "release" && current != "override" {
					t.Errorf("unexpected current model %q", current)
				}
				model.Set("")
			}
		})
	}
	wg.Wait()
	require.Equal(t, "release", model.Current())
}

func TestGatewaysReadModelPerRequest(t *testing.T) {
	for _, release := range []string{"", "gemma3:4b"} {
		t.Run("release="+release, func(t *testing.T) {
			model := NewModelSelector(release)
			requests := make(chan map[string]json.RawMessage, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var input map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				requests <- input
				writeCompletion(t, w, "reported", `{"fullName":"Name","cards":[]}`)
			}))
			defer server.Close()
			extractor, err := NewGatewayExtractor(server.URL, model, server.Client())
			require.NoError(t, err)
			splitter, err := NewGatewaySplitter(server.URL, model, server.Client())
			require.NoError(t, err)
			for _, override := range []string{"", "gpt-5-mini", "qwen3-vl-4b-instruct-fp8", ""} {
				model.Set(override)
				for _, invoke := range []func() error{
					func() error {
						_, err := extractor.Extract(t.Context(), nil, "image/jpeg", "Bearer caller")
						return err
					},
					func() error {
						_, err := splitter.Split(t.Context(), nil, "image/jpeg", 100, 100, "Bearer caller")
						return err
					},
				} {
					require.NoError(t, invoke())
					input := <-requests
					want := override
					if want == "" {
						want = release
					}
					if want == "" {
						require.NotContains(t, input, "model")
					} else {
						require.JSONEq(t, `"`+want+`"`, string(input["model"]))
					}
				}
			}
		})
	}
}
