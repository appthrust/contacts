package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/stretchr/testify/require"
)

// Sign the public assertion wire format with stdlib crypto so this partial
// workspace does not depend directly on another root-module package.
func assertionIdentity(t *testing.T) (*identity.Authenticator, func(string, ...string) string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	encode := base64.RawURLEncoding.EncodeToString
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/access/jwks.json", r.URL.Path)
		httpx.WriteJSON(w, 200, map[string]any{"keys": []any{map[string]string{"kty": "EC", "crv": "P-256", "kid": "test-key", "alg": "ES256", "use": "sig", "x": encode(key.X.FillBytes(make([]byte, 32))), "y": encode(key.Y.FillBytes(make([]byte, 32)))}}})
	}))
	t.Cleanup(server.Close)
	issuer := server.URL + "/access"
	auth, err := identity.New(identity.Trust{AccessIssuer: issuer, AccessAudience: "contacts"})
	require.NoError(t, err)
	return auth, func(project string, scopes ...string) string {
		claims, err := json.Marshal(map[string]any{"iss": issuer, "sub": "component:component", "aud": []string{"contacts"}, "scope": strings.Join(scopes, " "), "appthrust.io/project": project, "appthrust.io/key": "test-key", "appthrust.io/subject_kind": "component", "jti": "test", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix()})
		require.NoError(t, err)
		body := encode([]byte(`{"alg":"ES256","kid":"test-key","typ":"appthrust-access+jwt"}`)) + "." + encode(claims)
		digest := sha256.Sum256([]byte(body))
		r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
		require.NoError(t, err)
		signature := make([]byte, 64)
		r.FillBytes(signature[:32])
		s.FillBytes(signature[32:])
		return "Bearer " + body + "." + encode(signature)
	}
}
func TestAccessKeyScopesAndProjectBinding(t *testing.T) {
	auth, sign := assertionIdentity(t)
	h := New(nil, auth, nil, nil, Options{ProjectID: "pj-test"})
	for _, tc := range []struct {
		method, path, bearer string
		status               int
		code                 string
	}{
		{"GET", "/contacts", sign("pj-test", "contacts:write"), 403, "insufficient_scope"},
		{"POST", "/contacts", sign("pj-test", "contacts:read"), 403, "insufficient_scope"},
		{"DELETE", "/cards/id", sign("pj-test", "contacts:read"), 403, "insufficient_scope"},
		{"GET", "/settings", sign("pj-test", "contacts:write"), 403, "insufficient_scope"},
		{"PUT", "/settings", sign("pj-test", "contacts:read"), 403, "insufficient_scope"},
		{"POST", "/cards/id/unlink", sign("pj-test", "contacts:read"), 403, "insufficient_scope"},
		{"GET", "/openapi.json", sign("pj-other", "contacts:read"), 401, "unauthenticated"},
		{"GET", "/openapi.json", sign("pj-test"), 403, "insufficient_scope"},
		{"GET", "/me", "", 401, "unauthenticated"},
	} {
		r := httptest.NewRequest(tc.method, "/api/contacts/v1"+tc.path, nil)
		r.Header.Set("Authorization", tc.bearer)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		require.Equal(t, tc.status, w.Code, w.Body.String())
		require.Contains(t, w.Body.String(), `"error":"`+tc.code+`"`)
	}
	a := &API{identity: auth, options: Options{ProjectID: "pj-test"}}
	for _, method := range []string{"GET", "POST", "PATCH", "DELETE"} {
		scope := "contacts:write"
		if method == "GET" {
			scope = "contacts:read"
		}
		r := httptest.NewRequest(method, "/api/contacts/v1/contacts", nil)
		r.Header.Set("Authorization", sign("pj-test", scope))
		caller, _, err := a.authenticate(r)
		require.NoError(t, err)
		require.Equal(t, "key", caller.Principal.Kind)
	}
	var failure *httpx.Error
	require.ErrorAs(t, requireAdmin(&request{key: true}), &failure)
	require.Equal(t, "key_not_permitted", failure.Code)
}
func TestOpenAPIServedEqualsCommittedBytes(t *testing.T) {
	issuer := testutil.NewOIDCIssuer(t)
	auth, err := identity.New(identity.Trust{OIDCIssuer: issuer.Server.URL, OIDCCAPEM: issuer.CAPEM, OIDCAudiences: []string{"appthrust-platform-api"}})
	require.NoError(t, err)
	h := New(nil, auth, nil, nil, Options{ProjectID: "pj-test"})
	r := httptest.NewRequest(http.MethodGet, "/api/contacts/v1/openapi.json", nil)
	r.Header.Set("Authorization", issuer.Bearer(t))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	require.Equal(t, 200, w.Code, w.Body.String())
	committed, err := os.ReadFile("openapi.json")
	require.NoError(t, err)
	require.Equal(t, committed, w.Body.Bytes())
	var document struct {
		OpenAPI    string `json:"openapi"`
		Definition string `json:"x-appthrust-definition"`
		Servers    []struct {
			URL string `json:"url"`
		} `json:"servers"`
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(committed, &document))
	require.Equal(t, "3.0.3", document.OpenAPI)
	require.Equal(t, "contacts", document.Definition)
	require.Equal(t, "/api/contacts/v1", document.Servers[0].URL)
	operations := 0
	for _, methods := range document.Paths {
		operations += len(methods)
	}
	require.Equal(t, 32, operations)
	require.Contains(t, document.Paths["/settings"], "get")
	require.Contains(t, document.Paths["/settings"], "put")
	require.Contains(t, document.Paths["/cards/{id}/unlink"], "post")
	require.Contains(t, document.Paths["/sheets/{id}/image"], "get")
	var upload struct {
		Responses map[string]struct {
			Content map[string]struct {
				Schema struct {
					Ref string `json:"$ref"`
				} `json:"schema"`
			} `json:"content"`
		} `json:"responses"`
	}
	require.NoError(t, json.Unmarshal(document.Paths["/cards"]["post"], &upload))
	require.Equal(t, "#/components/schemas/UploadResponse", upload.Responses["202"].Content["application/json"].Schema.Ref)
	for name, fields := range map[string][]string{
		"Settings":       {"mode", "autoCreateThreshold", "autoLinkThreshold", "requiredFields", "privateDefault", "extractorPreference", "ocrModel"},
		"Extraction":     {"id", "engine", "model", "fields", "fieldConfidence", "overall", "durationMs", "createdAt"},
		"BusinessCard":   {"extraction", "decision", "decisionReason", "sheetId", "bbox"},
		"Sheet":          {"id", "detected", "imageUrl"},
		"UploadResponse": {"cards", "sheet"},
		"ContactChange":  {"source"},
	} {
		var schema struct {
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
		}
		require.NoError(t, json.Unmarshal(document.Components.Schemas[name], &schema))
		for _, field := range fields {
			require.Contains(t, schema.Properties, field, name)
			require.Contains(t, schema.Required, field, name)
		}
		if name == "BusinessCard" {
			require.NotContains(t, schema.Properties, "ocrFields")
			require.NotContains(t, schema.Required, "ocrFields")
		}
	}
	var me struct {
		Properties struct {
			OCR struct {
				Properties map[string]json.RawMessage `json:"properties"`
				Required   []string                   `json:"required"`
			} `json:"ocr"`
		} `json:"properties"`
	}
	require.NoError(t, json.Unmarshal(document.Components.Schemas["Me"], &me))
	for _, field := range []string{"model", "releaseModel", "models", "local"} {
		require.Contains(t, me.Properties.OCR.Properties, field)
		require.Contains(t, me.Properties.OCR.Required, field)
	}
	var models struct {
		Type  string `json:"type"`
		Items struct {
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(me.Properties.OCR.Properties["models"], &models))
	require.Equal(t, "array", models.Type)
	for _, field := range []string{"id", "ownedBy", "local"} {
		require.Contains(t, models.Items.Properties, field)
		require.Contains(t, models.Items.Required, field)
	}
}
func TestAccessKeyCannotUseAdminOperations(t *testing.T) {
	h := newHarness(t, nil)
	auth, sign := assertionIdentity(t)
	h.handler = New(h.db, auth, nil, nil, Options{ProjectID: "pj-test"})
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/cards?owner=all", ""}, {"GET", "/export.csv?scope=project", ""},
		{"POST", "/companies/target/merge", `{"sourceId":"source"}`},
		{"POST", "/tags", `{"name":"Shared","shared":true}`},
		{"PUT", "/settings", `{"mode":"auto"}`},
		{"POST", "/cards/id/unlink", ""},
	} {
		r := httptest.NewRequest(tc.method, "/api/contacts/v1"+tc.path, strings.NewReader(tc.body))
		r.Header.Set("Authorization", sign("pj-test", "contacts:read", "contacts:write"))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.handler.ServeHTTP(w, r)
		require.Equal(t, 403, w.Code, w.Body.String())
		require.Contains(t, w.Body.String(), "key_not_permitted")
	}
}
