package ocr

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestGatewaySplitter(t *testing.T) {
	image := []byte("sheet image")
	const authorization = "bEaReR caller-token"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected request: %s %s %v", r.Method, r.URL, r.Header)
		}
		if got := r.Header.Get("Authorization"); got != authorization {
			t.Errorf("Authorization=%q, want %q", got, authorization)
		}
		var input struct {
			Model       string `json:"model"`
			Temperature int    `json:"temperature"`
			MaxTokens   int    `json:"max_tokens"`
			Messages    []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
			ResponseFormat struct {
				Type       string `json:"type"`
				JSONSchema struct {
					Name   string          `json:"name"`
					Strict bool            `json:"strict"`
					Schema json.RawMessage `json:"schema"`
				} `json:"json_schema"`
			} `json:"response_format"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if input.Model != "qwen-vision" || input.Temperature != 0 || input.MaxTokens != 1500 {
			t.Errorf("unexpected generation parameters: %+v", input)
		}
		if len(input.Messages) != 2 || input.Messages[0].Role != "system" || input.Messages[1].Role != "user" {
			t.Errorf("unexpected messages: %+v", input.Messages)
			return
		}
		var instructions string
		if err := json.Unmarshal(input.Messages[0].Content, &instructions); err != nil || !strings.Contains(instructions, "every business card") || !strings.Contains(instructions, "[x1,y1,x2,y2]") {
			t.Errorf("missing split instructions: %s", input.Messages[0].Content)
		}
		var parts []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			ImageURL struct {
				URL string `json:"url"`
			} `json:"image_url"`
		}
		if err := json.Unmarshal(input.Messages[1].Content, &parts); err != nil || len(parts) != 2 {
			t.Errorf("invalid user content: %s", input.Messages[1].Content)
			return
		}
		if parts[0].Type != "text" || !strings.Contains(parts[0].Text, "1600") || !strings.Contains(parts[0].Text, "1200") || parts[1].Type != "image_url" || parts[1].ImageURL.URL != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(image) {
			t.Errorf("unexpected content parts: %+v", parts)
		}
		format := input.ResponseFormat
		if format.Type != "json_schema" || format.JSONSchema.Name == "" || !format.JSONSchema.Strict {
			t.Errorf("unexpected response format: %+v", format)
		}
		var gotSchema, wantSchema any
		if err := json.Unmarshal(format.JSONSchema.Schema, &gotSchema); err != nil {
			t.Errorf("invalid schema: %v", err)
		}
		const schema = `{"type":"object","properties":{"cards":{"type":"array","items":{"type":"object","properties":{"bbox":{"type":"array","items":{"type":"integer"},"minItems":4,"maxItems":4}},"required":["bbox"],"additionalProperties":false}}},"required":["cards"],"additionalProperties":false}`
		if err := json.Unmarshal([]byte(schema), &wantSchema); err != nil {
			t.Errorf("invalid expected schema: %v", err)
		}
		if !reflect.DeepEqual(gotSchema, wantSchema) {
			t.Errorf("schema=%s, want %s", format.JSONSchema.Schema, schema)
		}
		writeCompletion(t, w, "qwen-vision", `{"cards":[{"bbox":[-10,-20,500,500]},{"bbox":[550,600,1000,1000]}]}`)
	}))
	defer server.Close()
	splitter, err := NewGatewaySplitter(server.URL+"/", NewModelSelector("qwen-vision"), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if splitter.Name() != EngineGatewayVision {
		t.Fatalf("name=%s", splitter.Name())
	}
	got, err := splitter.Split(t.Context(), image, "image/png", 1600, 1200, authorization)
	want := []Region{{0, 0, 800, 600}, {880, 720, 1600, 1200}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("regions=%v error=%v, want %v", got, err, want)
	}
}

func TestGatewaySplitterCoordinates(t *testing.T) {
	for _, tc := range []struct {
		name          string
		width, height int
		content       string
		want          []Region
	}{
		{"pixels on small image", 800, 600, `{"cards":[{"bbox":[100,50,700,500]}]}`, []Region{{100, 50, 700, 500}}},
		{"width triggers scaling", 1600, 800, `{"cards":[{"bbox":[100,250,500,750]}]}`, []Region{{160, 200, 800, 600}}},
		{"height triggers scaling", 800, 1600, `{"cards":[{"bbox":[250,100,750,500]}]}`, []Region{{200, 160, 600, 800}}},
		{"integer pixel scaling", 1600, 1200, `{"cards":[{"bbox":[333,333,666,666]}]}`, []Region{{532, 399, 1065, 799}}},
		{"any coordinate above thousand means pixels", 1600, 1200, `{"cards":[{"bbox":[100,100,500,500]},{"bbox":[-20,-50,1800,1400]}]}`, []Region{{100, 100, 500, 500}, {0, 0, 1600, 1200}}},
		{"small image clamps without scaling", 800, 600, `{"cards":[{"bbox":[-20,-50,900,700]}]}`, []Region{{0, 0, 800, 600}}},
		{"fenced response", 800, 600, "```json\n" + `{"cards":[{"bbox":[0,0,200,100]}]}` + "\n```", []Region{{0, 0, 200, 100}}},
		{"no detections", 800, 600, `{"cards":[]}`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var input map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Errorf("decode request: %v", err)
				}
				if _, exists := input["model"]; exists {
					t.Error("empty model must use the gateway default")
				}
				writeCompletion(t, w, "", tc.content)
			}))
			defer server.Close()
			splitter, err := NewGatewaySplitter(server.URL, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			got, err := splitter.Split(t.Context(), nil, "image/jpeg", tc.width, tc.height, "Bearer caller-token")
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("regions=%v error=%v, want %v", got, err, tc.want)
			}
		})
	}
}

func TestGatewaySplitterErrors(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      int
		content     string
		unavailable bool
	}{
		{"caller rejected", 401, "caller secret", false},
		{"policy denied", 403, "provider secret", true},
		{"model missing", 404, "provider secret", true},
		{"gateway failure", 500, "provider secret", false},
		{"invalid regions", 200, "not JSON", false},
		{"null regions", 200, "null", false},
		{"missing cards", 200, `{}`, false},
		{"missing bbox", 200, `{"cards":[{}]}`, false},
		{"short bbox", 200, `{"cards":[{"bbox":[0,0,100]}]}`, false},
		{"long bbox", 200, `{"cards":[{"bbox":[0,0,100,100,100]}]}`, false},
		{"fractional coordinate", 200, `{"cards":[{"bbox":[0,0,100.5,100]}]}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				if tc.status == http.StatusOK {
					writeCompletion(t, w, "", tc.content)
				} else {
					_, _ = io.WriteString(w, tc.content)
				}
			}))
			defer server.Close()
			splitter, err := NewGatewaySplitter(server.URL, nil, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			_, err = splitter.Split(t.Context(), nil, "image/png", 1600, 1200, "Bearer caller-token")
			if err == nil || errors.Is(err, ErrUnavailable) != tc.unavailable {
				t.Fatalf("error=%v, want unavailable=%v", err, tc.unavailable)
			}
			if tc.status == http.StatusUnauthorized && err.Error() != "OCR gateway rejected the caller (401)" {
				t.Errorf("caller rejection=%v", err)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Errorf("response body leaked: %v", err)
			}
		})
	}
}

func TestNewGatewaySplitter(t *testing.T) {
	splitter, err := NewGatewaySplitter("", nil, nil)
	if splitter != nil || err != nil {
		t.Fatalf("unset gateway: splitter=%v error=%v", splitter, err)
	}
	for _, origin := range []string{"not a URL", "ftp://gateway", "http://user:password@gateway", "http://gateway?key=secret", "http://gateway#fragment"} {
		if _, err := NewGatewaySplitter(origin, nil, nil); err == nil {
			t.Errorf("invalid origin accepted: %s", origin)
		}
	}
}

func TestGatewaySplitterEmptyAuthorizationDoesNotCallGateway(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("gateway must not be called")
	})}
	splitter, err := NewGatewaySplitter("http://gateway.test", nil, client)
	if err != nil {
		t.Fatal(err)
	}
	_, err = splitter.Split(t.Context(), nil, "image/png", 1600, 1200, "")
	if !errors.Is(err, ErrUnavailable) || calls != 0 {
		t.Fatalf("error=%v calls=%d, want unavailable without an HTTP call", err, calls)
	}
}

func TestGatewaySplitterUsesContextDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client := &http.Client{
			Timeout: time.Second,
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				<-r.Context().Done()
				return nil, r.Context().Err()
			}),
		}
		splitter, err := NewGatewaySplitter("http://gateway.test", nil, client)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		defer cancel()
		start := time.Now()
		_, err = splitter.Split(ctx, nil, "image/png", 1600, 1200, "Bearer caller-token")
		if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) != 15*time.Second {
			t.Fatalf("error=%v elapsed=%v", err, time.Since(start))
		}
		if client.Timeout != time.Second {
			t.Errorf("caller client timeout mutated: %v", client.Timeout)
		}
	})
}

func TestGatewaySplitterHTTPDeadline(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	splitter, err := NewGatewaySplitter(server.URL, nil, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	_, err = splitter.Split(ctx, nil, "image/png", 1600, 1200, "Bearer caller-token")
	select {
	case <-started:
	default:
		t.Fatal("request never reached gateway")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v, want deadline exceeded", err)
	}
}
