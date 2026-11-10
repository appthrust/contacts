package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/registration"
	"github.com/appthrust/contacts/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

type harness struct {
	t        *testing.T
	handler  http.Handler
	db       *store.Store
	worker   *ocr.Worker
	auth     *identity.Authenticator
	platform *platformclient.Client
}

func token(subject string) string {
	claims, _ := json.Marshal(map[string]string{"sub": subject, "name": subject, "email": subject + "@example.test"})
	return "Bearer eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + "."
}
func newHarness(t *testing.T, extractor ocr.Extractor, directoryURL ...string) *harness {
	t.Helper()
	if dsn := os.Getenv("ADDONSERVER_TEST_DATABASE_URL"); dsn != "" {
		t.Setenv("BUILTIN_APPSERVER_TEST_DATABASE_URL", dsn)
	}
	db, _ := testutil.Database(t, store.Open)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NotEmpty(t, r.Header.Get("Authorization"))
		role := "Viewer"
		if r.Header.Get("Authorization") == token("admin") {
			role = "Admin"
		}
		switch r.URL.Path {
		case "/api/v1/projects/pj-test/access":
			httpx.WriteJSON(w, 200, map[string]any{"member": true, "roles": []string{role}, "actions": []string{}})
		case "/api/v1/projects/pj-test/app-installations/contacts":
			httpx.WriteJSON(w, 200, map[string]any{"id": "contacts", "links": []any{}})
		default:
			t.Errorf("unexpected platform path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	platform := platformclient.New(upstream.URL, "pj-test")
	var links *link.Client
	if len(directoryURL) > 0 {
		links = link.NewClient(link.NewResolver(platform, "contacts", func(key string) (string, bool) {
			if key == "CONTACTS_DIRECTORY_URL" {
				return directoryURL[0], true
			}
			return "", false
		}, map[string]link.Required{"directory": {URLEnv: "CONTACTS_DIRECTORY_URL", PublicURLEnv: "CONTACTS_DIRECTORY_PUBLIC_URL"}}), nil)
	}
	var extractors []ocr.Extractor
	if extractor != nil {
		extractors = []ocr.Extractor{extractor}
	}
	h := &harness{t: t, db: db, auth: auth, platform: platform, worker: ocr.NewWorker(db, extractors, registration.NewRegistrar(db), 2, time.Second)}
	h.handler = New(db, auth, platform, links, Options{ProjectID: "pj-test", DirectoryPublicURL: "https://directory.example.test", OCR: OCRInfo{Available: extractor != nil}, OCRQueue: h.worker})
	return h
}
func (h *harness) request(subject, method, path string, body io.Reader, contentType string, version int) *httptest.ResponseRecorder {
	h.t.Helper()
	r := httptest.NewRequest(method, "/api/contacts/v1"+path, body)
	if subject != "" {
		r.Header.Set("Authorization", token(subject))
	}
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	if version > 0 {
		r.Header.Set("If-Match", strconv.Itoa(version))
	}
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	return w
}
func call[T any](h *harness, subject, method, path string, body any, status int, version ...int) T {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		require.NoError(h.t, err)
		reader = bytes.NewReader(data)
	}
	v := 0
	if len(version) > 0 {
		v = version[0]
	}
	w := h.request(subject, method, path, reader, "application/json", v)
	require.Equal(h.t, status, w.Code, w.Body.String())
	var out T
	if status != 204 {
		require.NoError(h.t, json.Unmarshal(w.Body.Bytes(), &out), w.Body.String())
	}
	return out
}
func (h *harness) upload(subject, contact string) domain.BusinessCard {
	h.t.Helper()
	var imageData, body bytes.Buffer
	require.NoError(h.t, png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 4, 2))))
	writer := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{"Content-Disposition": {`form-data; name="image"; filename="card.png"`}, "Content-Type": {"image/png"}}
	part, err := writer.CreatePart(header)
	require.NoError(h.t, err)
	_, err = part.Write(imageData.Bytes())
	require.NoError(h.t, err)
	require.NoError(h.t, writer.WriteField("exchangedAt", "2026-10-01T12:00:00Z"))
	if contact != "" {
		require.NoError(h.t, writer.WriteField("contactId", contact))
	}
	require.NoError(h.t, writer.Close())
	w := h.request(subject, "POST", "/cards", &body, writer.FormDataContentType(), 0)
	require.Equal(h.t, 202, w.Code, w.Body.String())
	var out uploadResponse
	require.NoError(h.t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Len(h.t, out.Cards, 1)
	require.Nil(h.t, out.Sheet)
	return out.Cards[0]
}

type fakeExtractor struct{}

func (fakeExtractor) Name() string { return ocr.EngineGatewayVision }
func (fakeExtractor) Extract(context.Context, []byte, string, string) (ocr.Extraction, error) {
	return ocr.Extraction{
		Engine:          ocr.EngineGatewayVision,
		Model:           "test-model",
		Fields:          ocr.Fields{FullName: "Aoi Tanaka", Company: "Acme", Emails: []string{"aoi@example.test"}, Confidence: .95},
		FieldConfidence: map[string]float64{"fullName": .95},
		Overall:         .95,
	}, nil
}

type fakeOCRQueue struct {
	enqueue func(string, string)
	forget  func(string)
	kick    func()
}

func (q fakeOCRQueue) Enqueue(id, authorization string) { q.enqueue(id, authorization) }
func (q fakeOCRQueue) Forget(id string) {
	if q.forget != nil {
		q.forget(id)
	}
}
func (q fakeOCRQueue) Kick() { q.kick() }

func TestUploadAndRetryEnqueueCallerBearer(t *testing.T) {
	h := newHarness(t, fakeExtractor{})
	var enqueuedID, enqueuedAuthorization string
	var events []string
	visible := func(id string) bool {
		var count int
		require.NoError(t, h.db.Do(t.Context(), false, func(tx *store.Tx) error {
			return tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM cards WHERE id=$1 AND ocr_state='pending'`, id).Scan(&count)
		}))
		return count == 1
	}
	queue := fakeOCRQueue{
		enqueue: func(id, authorization string) {
			events = append(events, "enqueue")
			enqueuedID, enqueuedAuthorization = id, authorization
			// The worker must hold the credential before another transaction
			// can see, and therefore claim, the pending card.
			require.False(t, visible(id), "card committed before its credential was enqueued")
		},
		kick: func() {
			events = append(events, "kick")
			require.True(t, visible(enqueuedID), "worker woken before the card committed")
		},
	}
	h.handler = New(h.db, h.auth, h.platform, nil, Options{ProjectID: "pj-test", OCR: OCRInfo{Available: true}, OCRQueue: queue})
	card := h.upload("owner", "")
	require.Equal(t, card.ID, enqueuedID)
	require.Equal(t, token("owner"), enqueuedAuthorization)
	require.Equal(t, []string{"enqueue", "kick"}, events)

	events = nil
	call[httpx.Error](h, "owner", "POST", "/cards/"+card.ID+"/ocr", nil, 409)
	require.Empty(t, events)
	require.NoError(t, h.db.MarkUnavailable(t.Context(), card.ID))
	call[httpx.Error](h, "other", "POST", "/cards/"+card.ID+"/ocr", nil, 404)
	require.Empty(t, events)
	retried := call[domain.BusinessCard](h, "admin", "POST", "/cards/"+card.ID+"/ocr", nil, 202)
	require.Equal(t, "pending", retried.OCRState)
	require.Nil(t, retried.Extraction)
	require.Nil(t, retried.Decision)
	require.Nil(t, retried.DecisionReason)
	require.Equal(t, card.ID, enqueuedID)
	require.Equal(t, token("admin"), enqueuedAuthorization)
	require.Equal(t, []string{"enqueue", "kick"}, events)

	events = nil
	contact := call[domain.Contact](h, "owner", "POST", "/contacts", map[string]string{"fullName": "Existing contact"}, 201)
	linked := h.upload("owner", contact.ID)
	require.Equal(t, "unavailable", linked.OCRState)
	require.Empty(t, events)
	call[httpx.Error](h, "other", "POST", "/cards/"+linked.ID+"/ocr", nil, 403)
	require.Empty(t, events)
}

func TestUploadWorkerConfirmAndEncounters(t *testing.T) {
	h := newHarness(t, fakeExtractor{})
	settings := registration.Defaults()
	settings.Mode = "review"
	call[registration.Settings](h, "admin", "PUT", "/settings", settings, 200)
	card := h.upload("owner", "")
	require.Equal(t, "pending", card.OCRState)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); h.worker.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	require.Eventually(t, func() bool {
		card = call[domain.BusinessCard](h, "owner", "GET", "/cards/"+card.ID, nil, 200)
		return card.Decision != nil && *card.Decision == "NeedsReview"
	}, 3*time.Second, 10*time.Millisecond)
	require.Equal(t, "done", card.OCRState)
	require.NotNil(t, card.Extraction)
	require.Equal(t, "Aoi Tanaka", card.Extraction.Fields.FullName)
	require.NotEmpty(t, card.Extraction.ID)
	require.Equal(t, "policy", *card.DecisionReason)
	cardJSON := call[map[string]any](h, "owner", "GET", "/cards/"+card.ID, nil, 200)
	require.NotContains(t, cardJSON, "ocrFields")
	require.Contains(t, cardJSON, "extraction")
	require.Contains(t, cardJSON, "decision")
	require.Contains(t, cardJSON, "decisionReason")
	contact := call[domain.Contact](h, "owner", "POST", "/cards/"+card.ID+"/confirm", map[string]any{"contact": map[string]any{"fullName": "Aoi Tanaka", "emails": []string{"aoi@example.test"}}, "companyName": "Acme"}, 200)
	require.Equal(t, "active", contact.State)
	require.Equal(t, "member", contact.RegisteredBy)
	require.NotEmpty(t, contact.Changes)
	require.Equal(t, "member", contact.Changes[0].Source)
	require.Len(t, contact.Encounters, 1)
	require.Equal(t, 1, contact.Encounters[0].CardCount)
	second := h.upload("other", contact.ID)
	require.Equal(t, "unavailable", second.OCRState)
	contact = call[domain.Contact](h, "owner", "GET", "/contacts/"+contact.ID, nil, 200)
	require.Len(t, contact.Encounters, 2)
	require.Equal(t, 2, contact.EncounterCount)
	call[any](h, "owner", "DELETE", "/cards/"+second.ID, nil, 403)
	call[any](h, "admin", "DELETE", "/cards/"+second.ID, nil, 204)
	contact = call[domain.Contact](h, "owner", "GET", "/contacts/"+contact.ID, nil, 200)
	require.Len(t, contact.Encounters, 1)
	image := h.request("owner", "GET", "/cards/"+card.ID+"/image", nil, "", 0)
	require.Equal(t, 200, image.Code)
	require.Equal(t, "image/jpeg", image.Header().Get("Content-Type"))
	require.Equal(t, "private, max-age=3600", image.Header().Get("Cache-Control"))
	newContact := call[domain.Contact](h, "owner", "POST", "/contacts", map[string]string{"fullName": "New profile"}, 201)
	relinked := call[domain.Contact](h, "owner", "POST", "/cards/"+card.ID+"/confirm", map[string]string{"contactId": newContact.ID}, 200)
	require.Len(t, relinked.Encounters, 1)
	old := call[domain.Contact](h, "owner", "GET", "/contacts/"+contact.ID, nil, 200)
	require.Empty(t, old.Encounters)
}
func TestPrivateVisibilityVersionAndCSV(t *testing.T) {
	h := newHarness(t, nil)
	c := call[domain.Contact](h, "owner", "POST", "/contacts", map[string]any{"fullName": "Private Person", "visibility": "private", "emails": []string{"a@example.test"}}, 201)
	card := h.upload("owner", c.ID)
	for _, path := range []string{"/contacts/" + c.ID, "/cards/" + card.ID, "/cards/" + card.ID + "/image"} {
		call[httpx.Error](h, "other", "GET", path, nil, 404)
	}
	list := call[store.Page[domain.ContactSummary]](h, "other", "GET", "/contacts", nil, 200)
	require.Empty(t, list.Items)
	call[domain.Contact](h, "admin", "GET", "/contacts/"+c.ID, nil, 200)
	conflict := call[httpx.Error](h, "owner", "PATCH", "/contacts/"+c.ID, map[string]string{"title": "Updated"}, 409, c.Version)
	require.Equal(t, "version_conflict", conflict.Code)
	c = call[domain.Contact](h, "owner", "GET", "/contacts/"+c.ID, nil, 200)
	c = call[domain.Contact](h, "owner", "PATCH", "/contacts/"+c.ID, map[string]string{"title": "Updated"}, 200, c.Version)
	require.Equal(t, "Updated", *c.Title)
	call[httpx.Error](h, "owner", "PATCH", "/contacts/"+c.ID, map[string]string{"title": "No header"}, 400)
	csvResponse := h.request("owner", "GET", "/export.csv?scope=me", nil, "", 0)
	require.Equal(t, 200, csvResponse.Code)
	require.True(t, bytes.HasPrefix(csvResponse.Body.Bytes(), []byte("\xef\xbb\xbf")))
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(csvResponse.Body.String(), "\xef\xbb\xbf"))).ReadAll()
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, "Private Person", rows[1][0])
	require.Equal(t, "fullName", rows[0][0])
	require.Equal(t, "unknown member", rows[1][11])
	call[httpx.Error](h, "other", "GET", "/export.csv?scope=project", nil, 403)
	call[httpx.Error](h, "owner", "POST", "/cards/"+card.ID+"/ocr", nil, 409)
}
func TestCompanyMergeDuplicatesAndContactTags(t *testing.T) {
	h := newHarness(t, nil)
	first := call[domain.Contact](h, "owner", "POST", "/contacts", map[string]any{"fullName": "Ａｏｉ Tanaka", "companyName": "Acme", "emails": []string{"one@example.test"}}, 201)
	second := call[domain.Contact](h, "owner", "POST", "/contacts", map[string]any{"fullName": "Aoi　Tanaka", "companyName": "Other", "emails": []string{"two@example.test"}}, 201)
	duplicates := call[struct {
		Items []domain.DuplicateCandidate `json:"items"`
	}](h, "owner", "GET", "/contacts/duplicates", nil, 200)
	require.Len(t, duplicates.Items, 1)
	require.Equal(t, "name_domain", duplicates.Items[0].Reason)
	call[httpx.Error](h, "owner", "POST", "/companies/"+first.Company.ID+"/merge", map[string]string{"sourceId": second.Company.ID}, 403)
	merged := call[domain.Company](h, "admin", "POST", "/companies/"+first.Company.ID+"/merge", map[string]string{"sourceId": second.Company.ID}, 200)
	redirect := call[domain.Company](h, "owner", "GET", "/companies/"+second.Company.ID, nil, 200)
	require.Equal(t, merged.ID, redirect.ID)
	tag := call[domain.Tag](h, "owner", "POST", "/tags", map[string]any{"name": "Conference", "shared": false}, 201)
	call[any](h, "owner", "PUT", "/contacts/"+first.ID+"/tags/"+tag.ID, nil, 204, first.Version)
	first = call[domain.Contact](h, "owner", "GET", "/contacts/"+first.ID, nil, 200)
	require.Len(t, first.Tags, 1)
	mergedContact := call[domain.Contact](h, "owner", "POST", "/contacts/"+first.ID+"/merge", map[string]string{"sourceId": second.ID}, 200, first.Version)
	require.Len(t, mergedContact.Tags, 1)
	call[any](h, "owner", "DELETE", "/contacts/"+first.ID+"/tags/"+tag.ID, nil, 204, mergedContact.Version)
	first = call[domain.Contact](h, "owner", "GET", "/contacts/"+first.ID, nil, 200)
	require.Empty(t, first.Tags)
	call[any](h, "owner", "DELETE", "/contacts/"+first.ID, nil, 204, first.Version)
	list := call[store.Page[domain.ContactSummary]](h, "owner", "GET", "/contacts", nil, 200)
	require.Empty(t, list.Items)
}
func TestDirectoryResolutionCachedOnMutation(t *testing.T) {
	calls := 0
	directory := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "/api/directory/v1/me", r.URL.Path)
		require.Equal(t, token("owner"), r.Header.Get("Authorization"))
		httpx.WriteJSON(w, 200, map[string]any{"person": map[string]string{"id": "person-id", "displayName": "Directory Name"}})
	}))
	defer directory.Close()
	h := newHarness(t, nil, directory.URL)
	me := call[meResponse](h, "owner", "GET", "/me", nil, 200)
	require.Equal(t, "person-id", *me.Member.DirectoryPersonID)
	require.True(t, me.Directory.Linked)
	c := call[domain.Contact](h, "owner", "POST", "/contacts", map[string]string{"fullName": "Contact"}, 201)
	require.Equal(t, "Directory Name", c.CreatedBy.DisplayName)
	require.Equal(t, 1, calls)
}
