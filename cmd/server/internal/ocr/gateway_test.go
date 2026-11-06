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

func TestGatewayExtractor(t *testing.T) {
	for _, fenced := range []bool{false, true} {
		name := "json"
		if fenced {
			name = "fenced"
		}
		t.Run(name, func(t *testing.T) {
			image := []byte("card image")
			const authorization = "bEaReR caller-token"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("unexpected request: %s %s %v", r.Method, r.URL, r.Header)
				}
				if got := r.Header.Get("Authorization"); got != authorization {
					t.Errorf("Authorization = %q, want %q", got, authorization)
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
							Name   string `json:"name"`
							Strict bool   `json:"strict"`
							Schema struct {
								Type                 string                     `json:"type"`
								Properties           map[string]json.RawMessage `json:"properties"`
								Required             []string                   `json:"required"`
								AdditionalProperties bool                       `json:"additionalProperties"`
							} `json:"schema"`
						} `json:"json_schema"`
					} `json:"response_format"`
				}
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Errorf("decode request: %v", err)
					return
				}
				if input.Model != "vision-model" || input.Temperature != 0 || input.MaxTokens <= 0 || input.MaxTokens > 4096 {
					t.Errorf("unexpected generation parameters: %+v", input)
				}
				if len(input.Messages) != 2 || input.Messages[0].Role != "system" || input.Messages[1].Role != "user" {
					t.Errorf("unexpected messages: %+v", input.Messages)
					return
				}
				var instructions string
				if err := json.Unmarshal(input.Messages[0].Content, &instructions); err != nil || !strings.Contains(instructions, "Japanese") || !strings.Contains(instructions, "English") {
					t.Errorf("missing extraction instructions: %s", input.Messages[0].Content)
				}
				for _, phrase := range []string{
					"Return kana ONLY if furigana/kana is printed on the card. Romaji is not kana. Otherwise null.",
					"Example: a card showing 山田 太郎 and Taro Yamada without furigana must return kana: null.",
					"department = organisational unit (部, 課, 事業部, Division); title = role or rank (部長, 代表社員, Manager, 弁護士). Never put a title in department.",
					"Rate each field independently; fields you could not read must be low (≤ 0.3), not the same value as the others.",
				} {
					if !strings.Contains(instructions, phrase) {
						t.Errorf("missing extraction instruction %q", phrase)
					}
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
				if parts[0].Type != "text" || parts[0].Text == "" || parts[1].Type != "image_url" || parts[1].ImageURL.URL != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(image) {
					t.Errorf("unexpected content parts: %+v", parts)
				}
				format := input.ResponseFormat
				if format.Type != "json_schema" || format.JSONSchema.Name != "business_card" || !format.JSONSchema.Strict || format.JSONSchema.Schema.Type != "object" || format.JSONSchema.Schema.AdditionalProperties {
					t.Errorf("unexpected response format: %+v", format)
				}
				keys := []string{"fullName", "kana", "company", "department", "title", "emails", "phones", "address", "url", "confidence", "fieldConfidence", "overall"}
				if !reflect.DeepEqual(format.JSONSchema.Schema.Required, keys) || len(format.JSONSchema.Schema.Properties) != len(keys) {
					t.Errorf("incorrect Fields schema: %+v", format.JSONSchema.Schema)
				}
				for _, key := range keys {
					if _, ok := format.JSONSchema.Schema.Properties[key]; !ok {
						t.Errorf("missing schema property %q", key)
					}
				}
				var confidenceSchema struct {
					Type       string `json:"type"`
					Properties map[string]struct {
						Type string `json:"type"`
					} `json:"properties"`
					Required             []string `json:"required"`
					AdditionalProperties bool     `json:"additionalProperties"`
				}
				if err := json.Unmarshal(format.JSONSchema.Schema.Properties["fieldConfidence"], &confidenceSchema); err != nil {
					t.Errorf("invalid fieldConfidence schema: %v", err)
				}
				if confidenceSchema.Type != "object" || confidenceSchema.AdditionalProperties || !reflect.DeepEqual(confidenceSchema.Required, keys[:9]) || len(confidenceSchema.Properties) != 9 {
					t.Errorf("incorrect fieldConfidence schema: %+v", confidenceSchema)
				}
				for _, key := range keys[:9] {
					if confidenceSchema.Properties[key].Type != "number" {
						t.Errorf("fieldConfidence %s is not numeric", key)
					}
				}
				content := `{"fullName":"山田 太郎","kana":"ヤマダ タロウ","company":"Example","department":"Sales","title":"Director","emails":[" taro@example.com ","taro@example.com",""," other@example.com"],"phones":[" 03-1234-5678 ","03-1234-5678"," "],"address":null,"url":"https://example.com","confidence":1.4,"overall":0.85,"fieldConfidence":{"fullName":1.2,"company":-0.2,"emails":0.95}}`
				if fenced {
					content = " \n```json\n" + content + "\n```\n "
				}
				writeCompletion(t, w, "reported-model", content)
			}))
			defer server.Close()
			extractor, err := NewGatewayExtractor(server.URL+"/", NewModelSelector("vision-model"), server.Client())
			if err != nil {
				t.Fatal(err)
			}
			got, err := extractor.Extract(context.Background(), image, "image/png", authorization)
			if err != nil {
				t.Fatal(err)
			}
			want := Fields{FullName: "山田 太郎", Kana: "ヤマダ タロウ", Company: "Example", Department: "Sales", Title: "Director", Emails: []string{"taro@example.com", "other@example.com"}, Phones: []string{"03-1234-5678"}, URL: "https://example.com", Confidence: 1}
			if !reflect.DeepEqual(got.Fields, want) {
				t.Fatalf("fields = %+v, want %+v", got.Fields, want)
			}
			if extractor.Name() != EngineGatewayVision || got.Engine != EngineGatewayVision || got.Model != "reported-model" || got.Overall != 0.85 || got.ID != "" || !got.CreatedAt.IsZero() {
				t.Fatalf("unexpected extraction metadata: %+v", got)
			}
			wantConfidence := map[string]float64{"fullName": 1, "kana": 0.85, "company": 0, "department": 0.85, "title": 0.85, "emails": 0.95, "phones": 0.85, "address": 0.85, "url": 0.85}
			if !reflect.DeepEqual(got.FieldConfidence, wantConfidence) {
				t.Fatalf("field confidence = %v, want %v", got.FieldConfidence, wantConfidence)
			}
		})
	}
}

func TestGatewayDefaultModelAndConfidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if _, exists := input["model"]; exists {
			t.Error("empty model must be omitted to use the gateway default")
		}
		writeCompletion(t, w, "", "```\n"+`{"fullName":"Alice","confidence":-0.5}`+"\n```")
	}))
	defer server.Close()
	extractor, err := NewGatewayExtractor(server.URL, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	x, err := extractor.Extract(context.Background(), []byte("image"), "image/jpeg", "Bearer caller-token")
	if err != nil || x.Overall != 0 || x.Fields.Confidence != 0 || x.Fields.Emails == nil || x.Fields.Phones == nil || x.Model != "" {
		t.Fatalf("extraction=%+v error=%v", x, err)
	}
}

func TestGatewayErrors(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      int
		body        string
		unavailable bool
	}{
		{"caller rejected", 401, "caller secret must not escape", false},
		{"policy denied", 403, `{"error":{"code":"ai_model_denied"}}`, true},
		{"model not found", 404, `{"error":{"code":"model_not_found"}}`, true},
		{"upstream failure", 500, "upstream secret must not escape", false},
		{"oversized response", 200, `{"choices":[]}` + strings.Repeat(" ", 1<<20), false},
		{"invalid envelope", 200, "not JSON", false},
		{"no choices", 200, `{"choices":[]}`, false},
		{"invalid fields", 200, `{"choices":[{"message":{"content":"not JSON"}}]}`, false},
		{"null fields", 200, `{"choices":[{"message":{"content":"null"}}]}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			extractor, err := NewGatewayExtractor(server.URL, nil, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			_, err = extractor.Extract(context.Background(), nil, "image/jpeg", "Bearer caller-token")
			if err == nil || errors.Is(err, ErrUnavailable) != tc.unavailable {
				t.Fatalf("error=%v, want unavailable=%v", err, tc.unavailable)
			}
			if tc.status == http.StatusUnauthorized && err.Error() != "OCR gateway rejected the caller (401)" {
				t.Fatalf("unexpected caller rejection: %v", err)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatalf("upstream body leaked: %v", err)
			}
		})
	}
}

func TestNewGatewayExtractor(t *testing.T) {
	extractor, err := NewGatewayExtractor("", nil, nil)
	if extractor != nil || err != nil {
		t.Fatalf("unset gateway: extractor=%v error=%v", extractor, err)
	}
	for _, origin := range []string{"not a URL", "ftp://gateway", "http://user:password@gateway", "http://gateway?key=secret", "http://gateway#fragment"} {
		if _, err := NewGatewayExtractor(origin, nil, nil); err == nil {
			t.Errorf("invalid origin accepted: %s", origin)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestGatewayEmptyAuthorizationDoesNotCallGateway(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("gateway must not be called")
	})}
	extractor, err := NewGatewayExtractor("http://gateway.test", nil, client)
	if err != nil {
		t.Fatal(err)
	}
	_, err = extractor.Extract(context.Background(), []byte("image"), "image/jpeg", "")
	if !errors.Is(err, ErrUnavailable) || calls != 0 {
		t.Fatalf("error=%v calls=%d, want unavailable without an HTTP call", err, calls)
	}
}

func TestGatewayUsesContextDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client := &http.Client{
			Timeout: time.Second,
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				<-r.Context().Done()
				return nil, r.Context().Err()
			}),
		}
		extractor, err := NewGatewayExtractor("http://gateway.test", nil, client)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		start := time.Now()
		_, err = extractor.Extract(ctx, nil, "image/jpeg", "Bearer caller-token")
		if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) != 2*time.Second {
			t.Fatalf("error=%v elapsed=%v", err, time.Since(start))
		}
		if client.Timeout != time.Second {
			t.Fatalf("caller client timeout mutated: %v", client.Timeout)
		}
	})
}

func writeCompletion(t *testing.T, w http.ResponseWriter, model, content string) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(map[string]any{"model": model, "choices": []any{map[string]any{"message": map[string]string{"content": content}}}}); err != nil {
		t.Errorf("write completion: %v", err)
	}
}

func TestGatewayConfidenceDefaults(t *testing.T) {
	for _, tc := range []struct {
		name    string
		content string
		overall float64
	}{
		{"legacy confidence", `{"fullName":"Alice","confidence":0.7}`, 0.7},
		{"overall overrides legacy", `{"fullName":"Alice","confidence":0.9,"overall":0}`, 0},
		{"clamp above one", `{"overall":1.5,"confidence":0.2}`, 1},
		{"clamp below zero", `{"overall":-0.5,"confidence":0.9}`, 0},
		{"legacy clamp above one", `{"confidence":1.5}`, 1},
		{"no confidence", `{}`, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				w := httptest.NewRecorder()
				writeCompletion(t, w, "", tc.content)
				return w.Result(), nil
			})}
			extractor, err := NewGatewayExtractor("http://gateway.test", NewModelSelector("requested-model"), client)
			if err != nil {
				t.Fatal(err)
			}
			x, err := extractor.Extract(t.Context(), nil, "image/jpeg", "Bearer caller-token")
			if err != nil {
				t.Fatal(err)
			}
			if x.Overall != tc.overall || x.Model != "" {
				t.Fatalf("extraction=%+v, want overall=%v with no model fallback", x, tc.overall)
			}
			for _, field := range []string{"fullName", "kana", "company", "department", "title", "emails", "phones", "address", "url"} {
				if confidence, ok := x.FieldConfidence[field]; !ok || confidence != tc.overall {
					t.Errorf("%s confidence=%v present=%v, want %v", field, confidence, ok, tc.overall)
				}
			}
		})
	}
}

func TestGatewayExtractionDuration(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			time.Sleep(1500 * time.Millisecond)
			w := httptest.NewRecorder()
			writeCompletion(t, w, "reported-model", `{"overall":0.9}`)
			return w.Result(), nil
		})}
		extractor, err := NewGatewayExtractor("http://gateway.test", nil, client)
		if err != nil {
			t.Fatal(err)
		}
		x, err := extractor.Extract(t.Context(), nil, "image/jpeg", "Bearer caller-token")
		if err != nil || x.DurationMs != 1500 {
			t.Fatalf("duration=%d error=%v, want 1500ms", x.DurationMs, err)
		}
	})
}
