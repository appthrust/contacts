package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/registration"
	"github.com/appthrust/contacts/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestSettingsDefaultsAndAdminUpdate(t *testing.T) {
	h := newHarness(t, nil)
	defaults := registration.Settings{
		Mode:                "auto",
		AutoCreateThreshold: .85,
		AutoLinkThreshold:   .9,
		RequiredFields:      []string{"fullName"},
		PrivateDefault:      false,
		ExtractorPreference: []string{"gateway-vision"},
	}
	require.Equal(t, defaults, call[registration.Settings](h, "owner", "GET", "/settings", nil, 200))

	var notifications []registration.Settings
	h.handler.(*API).options.OnSettingsChanged = func(settings registration.Settings) {
		// A new transaction must see committed settings before runtime changes.
		require.NoError(t, h.db.Do(t.Context(), false, func(tx *store.Tx) error {
			stored, err := tx.Settings()
			require.NoError(t, err)
			require.Equal(t, settings, stored)
			return err
		}))
		notifications = append(notifications, settings)
	}
	updated := defaults
	updated.Mode = "review"
	updated.AutoCreateThreshold = 0
	updated.AutoLinkThreshold = 1
	updated.PrivateDefault = true
	updated.OCRModel = "gpt-5-mini"
	call[httpx.Error](h, "owner", "PUT", "/settings", updated, 403)
	require.Empty(t, notifications)
	require.Equal(t, defaults, call[registration.Settings](h, "owner", "GET", "/settings", nil, 200))
	require.Equal(t, updated, call[registration.Settings](h, "admin", "PUT", "/settings", updated, 200))
	require.Equal(t, []registration.Settings{updated}, notifications)
	require.Equal(t, updated, call[registration.Settings](h, "owner", "GET", "/settings", nil, 200))
}

func TestSettingsRejectInvalidPolicy(t *testing.T) {
	h := newHarness(t, nil)
	notifications := 0
	h.handler.(*API).options.OnSettingsChanged = func(registration.Settings) { notifications++ }
	for _, tc := range []struct {
		name   string
		change func(*registration.Settings)
	}{
		{"unknown mode", func(s *registration.Settings) { s.Mode = "manual" }},
		{"missing mode", func(s *registration.Settings) { s.Mode = "" }},
		{"create below zero", func(s *registration.Settings) { s.AutoCreateThreshold = -.01 }},
		{"create above one", func(s *registration.Settings) { s.AutoCreateThreshold = 1.01 }},
		{"link below zero", func(s *registration.Settings) { s.AutoLinkThreshold = -.01 }},
		{"link above one", func(s *registration.Settings) { s.AutoLinkThreshold = 1.01 }},
		{"model whitespace", func(s *registration.Settings) { s.OCRModel = "gpt mini" }},
		{"model control", func(s *registration.Settings) { s.OCRModel = "gpt\u0000mini" }},
		{"model too long", func(s *registration.Settings) { s.OCRModel = strings.Repeat("a", 129) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := registration.Defaults()
			tc.change(&s)
			call[httpx.Error](h, "admin", "PUT", "/settings", s, 400)
		})
	}
	require.Zero(t, notifications)
	require.Equal(t, registration.Defaults(), call[registration.Settings](h, "owner", "GET", "/settings", nil, 200))
}

func TestSettingsAccessKeyCanRead(t *testing.T) {
	h := newHarness(t, nil)
	auth, sign := assertionIdentity(t)
	h.handler = New(h.db, auth, nil, nil, Options{ProjectID: "pj-test"})
	r := httptest.NewRequest(http.MethodGet, "/api/contacts/v1/settings", nil)
	r.Header.Set("Authorization", sign("pj-test", "contacts:read"))
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	require.Equal(t, 200, w.Code, w.Body.String())
	var settings registration.Settings
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &settings))
	require.Equal(t, registration.Defaults(), settings)
}

func TestUnlinkCardOwnerAndAdmin(t *testing.T) {
	h := newHarness(t, nil)
	contact := call[domain.Contact](h, "owner", "POST", "/contacts", map[string]string{"fullName": "Existing contact"}, 201)
	for _, actor := range []string{"owner", "admin"} {
		card := h.upload("owner", contact.ID)
		call[httpx.Error](h, "other", "POST", "/cards/"+card.ID+"/unlink", nil, 403)
		linked := call[domain.BusinessCard](h, "owner", "GET", "/cards/"+card.ID, nil, 200)
		require.Equal(t, contact.ID, *linked.ContactID)
		unlinked := call[domain.BusinessCard](h, actor, "POST", "/cards/"+card.ID+"/unlink", nil, 200)
		require.Equal(t, card.ID, unlinked.ID)
		require.Nil(t, unlinked.ContactID)
		require.NotNil(t, unlinked.Decision)
		require.Equal(t, "NeedsReview", *unlinked.Decision)
		require.NotNil(t, unlinked.DecisionReason)
		require.Equal(t, "unlinked", *unlinked.DecisionReason)
		profile := call[domain.Contact](h, "owner", "GET", "/contacts/"+contact.ID, nil, 200)
		require.Empty(t, profile.Cards)
		require.Empty(t, profile.Encounters)
		require.Equal(t, "active", profile.State)
	}
}

func TestSettingsModelChangesNextOCRRequest(t *testing.T) {
	requested := make(chan string, 1)
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, token("owner"), r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/v1/models":
			httpx.WriteJSON(w, 200, map[string]any{"data": []any{
				map[string]string{"id": "gemma3:4b", "owned_by": "appthrust"},
				map[string]string{"id": "gpt-5-mini", "owned_by": "openai"},
				map[string]string{"id": "qwen3-vl-4b-instruct-fp8", "owned_by": "vision"},
			}})
		case "/v1/chat/completions":
			var input struct {
				Model string `json:"model"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
			requested <- input.Model
			httpx.WriteJSON(w, 200, map[string]any{
				"model":   input.Model,
				"choices": []any{map[string]any{"message": map[string]string{"content": `{"fullName":"Name","confidence":0.95}`}}},
			})
		default:
			t.Errorf("unexpected gateway path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer gateway.Close()
	model := ocr.NewModelSelector("gemma3:4b")
	extractor, err := ocr.NewGatewayExtractor(gateway.URL, model, gateway.Client())
	require.NoError(t, err)
	h := newHarness(t, extractor)
	options := &h.handler.(*API).options
	options.OCR = OCRInfo{
		Available: true, Extractor: extractor.Name(), ReleaseModel: "gemma3:4b",
		Probe: NewOCRLocalProbe(gateway.URL, model.Current, gateway.Client()),
	}
	var notifications int
	options.OnSettingsChanged = func(s registration.Settings) {
		notifications++
		model.Set(s.OCRModel)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); h.worker.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	for _, override := range []string{"gpt-5-mini", "qwen3-vl-4b-instruct-fp8", ""} {
		s := registration.Defaults()
		s.OCRModel = override
		require.Equal(t, s, call[registration.Settings](h, "admin", "PUT", "/settings", s, 200))
		want := override
		if want == "" {
			want = "gemma3:4b"
		}
		me := call[meResponse](h, "owner", "GET", "/me", nil, 200)
		require.Equal(t, want, me.OCR.Model)
		require.Equal(t, "gemma3:4b", me.OCR.ReleaseModel)
		require.Equal(t, want != "gpt-5-mini", me.OCR.Local)
		require.Equal(t, []OCRModel{
			{ID: "gemma3:4b", OwnedBy: "appthrust", Local: true},
			{ID: "gpt-5-mini", OwnedBy: "openai"},
			{ID: "qwen3-vl-4b-instruct-fp8", OwnedBy: "vision", Local: true},
		}, me.OCR.Models)
		card := h.upload("owner", "")
		require.Eventually(t, func() bool {
			card = call[domain.BusinessCard](h, "owner", "GET", "/cards/"+card.ID, nil, 200)
			return card.OCRState == "done"
		}, 3*time.Second, 10*time.Millisecond)
		require.Equal(t, want, <-requested)
		require.NotNil(t, card.Extraction)
		require.Equal(t, want, card.Extraction.Model)
	}
	require.Equal(t, 3, notifications)
}
