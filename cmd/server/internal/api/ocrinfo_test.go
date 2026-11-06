package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/stretchr/testify/require"
)

func TestOCRLocalProbeModelSelection(t *testing.T) {
	for _, tc := range []struct {
		name, model, body string
		status            int
		local             bool
	}{
		{"local", "vision", `{"data":[{"id":"vision","owned_by":"llm"}]}`, 200, true},
		{"openai", "vision", `{"data":[{"id":"vision","owned_by":"openai"}]}`, 200, false},
		{"anthropic", "vision", `{"data":[{"id":"vision","owned_by":"anthropic"}]}`, 200, false},
		{"configured model", "vision", `{"data":[{"id":"remote","owned_by":"openai"},{"id":"vision","owned_by":"llm"}]}`, 200, true},
		{"first model", "", `{"data":[{"id":"vision","owned_by":"llm"},{"id":"remote","owned_by":"openai"}]}`, 200, true},
		{"first remote", "", `{"data":[{"id":"remote","owned_by":"openai"},{"id":"vision","owned_by":"llm"}]}`, 200, false},
		{"missing model", "missing", `{"data":[{"id":"vision","owned_by":"llm"}]}`, 200, false},
		{"empty models", "", `{"data":[]}`, 200, false},
		{"invalid response", "vision", `{`, 200, false},
		{"denied", "vision", `{"data":[{"id":"vision","owned_by":"llm"}]}`, 403, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				require.Equal(t, "GET", r.Method)
				require.Equal(t, "/v1/models", r.URL.Path)
				require.Equal(t, token("owner"), r.Header.Get("Authorization"))
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			probe := NewOCRLocalProbe(server.URL, func() string { return tc.model }, server.Client())
			require.Equal(t, tc.local, probe(t.Context(), token("owner")).Local)
			require.Equal(t, tc.local, probe(t.Context(), token("owner")).Local)
			info := probe(t.Context(), token("owner"))
			require.Equal(t, tc.model, info.Model)
			require.NotNil(t, info.Models)
			if tc.status != 200 || tc.body == "{" {
				require.Empty(t, info.Models)
			}
			require.EqualValues(t, 1, calls.Load(), "successes and failures are cached")
		})
	}
}

func TestOCRLocalProbeUsesCallerAuthority(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		owner := "openai"
		if r.Header.Get("Authorization") == token("local-member") {
			owner = "llm"
		}
		httpx.WriteJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "vision", "owned_by": owner}}})
	}))
	probe := NewOCRLocalProbe(server.URL, func() string { return "vision" }, server.Client())
	require.False(t, probe(t.Context(), "").Local)
	require.True(t, probe(t.Context(), token("local-member")).Local)
	require.False(t, probe(t.Context(), token("remote-member")).Local)
	require.True(t, probe(t.Context(), token("local-member")).Local)
	require.EqualValues(t, 2, calls.Load())
	server.Close()
	require.False(t, probe(t.Context(), token("new-member")).Local, "transport failure is non-fatal")
	require.Empty(t, probe(t.Context(), token("new-member")).Models)
	require.False(t, NewOCRLocalProbe("", nil, nil)(t.Context(), token("owner")).Local)
}

func TestMeOCRShapeAndLocality(t *testing.T) {
	for _, owner := range []string{"llm", "openai"} {
		t.Run(owner, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/v1/models", r.URL.Path)
				require.Equal(t, token("owner"), r.Header.Get("Authorization"))
				httpx.WriteJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "vision", "owned_by": owner}}})
			}))
			defer server.Close()
			h := newHarness(t, nil)
			h.handler.(*API).options.OCR = OCRInfo{
				Available:    true,
				Extractor:    ocr.EngineGatewayVision,
				ReleaseModel: "vision",
				Probe:        NewOCRLocalProbe(server.URL, func() string { return "vision" }, server.Client()),
			}
			me := call[map[string]any](h, "owner", "GET", "/me", nil, 200)
			require.Equal(t, map[string]any{
				"available": true, "extractor": "gateway-vision", "model": "vision", "releaseModel": "vision",
				"local": owner == "llm", "sheetSplit": false,
				"models": []any{map[string]any{"id": "vision", "ownedBy": owner, "local": owner == "llm"}},
			}, me["ocr"])
		})
	}
}

func TestOCRLocalProbeCachesByModelAndExpires(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls int
		model := ocr.NewModelSelector("")
		client := &http.Client{Transport: probeTransport(func(*http.Request) (*http.Response, error) {
			calls++
			w := httptest.NewRecorder()
			_, _ = w.WriteString(`{"data":[{"id":"gemma3:4b","owned_by":"appthrust"},{"id":"gpt-5-mini","owned_by":"openai"},{"id":"qwen3-vl-4b-instruct-fp8","owned_by":"vision"},{"id":"claude","owned_by":"anthropic"}]}`)
			return w.Result(), nil
		})}
		probe := NewOCRLocalProbe("http://gateway.test", model.Current, client)
		info := probe(context.Background(), "Bearer member")
		require.True(t, info.Local)
		require.Equal(t, []OCRModel{
			{ID: "gemma3:4b", OwnedBy: "appthrust", Local: true},
			{ID: "gpt-5-mini", OwnedBy: "openai"},
			{ID: "qwen3-vl-4b-instruct-fp8", OwnedBy: "vision", Local: true},
			{ID: "claude", OwnedBy: "anthropic"},
		}, info.Models)
		model.Set("gpt-5-mini")
		info = probe(context.Background(), "Bearer member")
		require.Equal(t, "gpt-5-mini", info.Model)
		require.False(t, info.Local)
		require.Equal(t, 2, calls)
		model.Set("")
		require.True(t, probe(context.Background(), "Bearer member").Local)
		require.Equal(t, 2, calls)
		time.Sleep(time.Minute)
		require.True(t, probe(context.Background(), "Bearer member").Local)
		require.Equal(t, 3, calls)
	})
}

type probeTransport func(*http.Request) (*http.Response, error)

func (f probeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
