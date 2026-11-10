package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"time"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/registration"
	"github.com/appthrust/contacts/cmd/server/internal/store"
)

type Options struct {
	ProjectID          string
	DirectoryPublicURL string
	OCR                OCRInfo
	OCRQueue           ocrQueue
	Splitter           ocr.Splitter
	OnSettingsChanged  func(registration.Settings)
}
type API struct {
	store    *store.Store
	identity *identity.Authenticator
	platform *platformclient.Client
	links    *link.Client
	options  Options
	mux      *http.ServeMux
}
type request struct {
	r          *http.Request
	w          http.ResponseWriter
	tx         *store.Tx
	member     domain.Member
	viewer     store.Viewer
	bearer     string
	key        bool
	ocrCardIDs []string
	settings   *registration.Settings
}
type rawResponse struct {
	body                                   []byte
	contentType, cacheControl, disposition string
}
type endpoint func(*request) (any, int, error)

func New(database *store.Store, auth *identity.Authenticator, platform *platformclient.Client, links *link.Client, options Options) http.Handler {
	a := &API{store: database, identity: auth, platform: platform, links: links, options: options, mux: http.NewServeMux()}
	a.mux.HandleFunc("GET /api/contacts/v1/openapi.json", a.openapi)
	a.route("GET /api/contacts/v1/me", true, true, a.me)
	a.route("GET /api/contacts/v1/settings", false, true, a.settings)
	a.route("PUT /api/contacts/v1/settings", true, true, a.putSettings)
	a.route("POST /api/contacts/v1/cards", true, true, a.upload)
	a.route("GET /api/contacts/v1/cards", false, true, a.cards)
	a.route("GET /api/contacts/v1/cards/{id}", false, true, a.card)
	a.route("GET /api/contacts/v1/cards/{id}/image", false, true, a.image)
	a.route("GET /api/contacts/v1/sheets/{id}/image", false, true, a.sheetImage)
	a.route("POST /api/contacts/v1/cards/{id}/confirm", true, true, a.confirm)
	a.route("POST /api/contacts/v1/cards/{id}/ocr", true, true, a.retryOCR)
	a.route("POST /api/contacts/v1/cards/{id}/unlink", true, true, a.unlinkCard)
	a.route("DELETE /api/contacts/v1/cards/{id}", true, true, a.deleteCard)
	a.route("GET /api/contacts/v1/contacts", false, true, a.contacts)
	a.route("POST /api/contacts/v1/contacts", true, true, a.createContact)
	a.route("GET /api/contacts/v1/contacts/duplicates", false, true, a.duplicates)
	a.route("GET /api/contacts/v1/contacts/{id}", false, true, a.contact)
	a.route("PATCH /api/contacts/v1/contacts/{id}", true, true, a.patchContact)
	a.route("DELETE /api/contacts/v1/contacts/{id}", true, true, a.archiveContact)
	a.route("POST /api/contacts/v1/contacts/{id}/merge", true, true, a.mergeContact)
	a.route("PUT /api/contacts/v1/contacts/{id}/tags/{tagId}", true, true, a.contactTag)
	a.route("DELETE /api/contacts/v1/contacts/{id}/tags/{tagId}", true, true, a.contactTag)
	a.route("GET /api/contacts/v1/companies", false, true, a.companies)
	a.route("POST /api/contacts/v1/companies", true, true, a.createCompany)
	a.route("GET /api/contacts/v1/companies/{id}", false, true, a.company)
	a.route("PATCH /api/contacts/v1/companies/{id}", true, true, a.patchCompany)
	a.route("POST /api/contacts/v1/companies/{id}/merge", true, true, a.mergeCompany)
	a.route("GET /api/contacts/v1/tags", false, true, a.tags)
	a.route("POST /api/contacts/v1/tags", true, true, a.createTag)
	a.route("DELETE /api/contacts/v1/tags/{id}", true, true, a.deleteTag)
	a.route("GET /api/contacts/v1/me/contacts", false, true, a.myContacts)
	a.route("GET /api/contacts/v1/export.csv", false, true, a.export)
	a.route("/", false, false, func(*request) (any, int, error) { return nil, 0, httpx.NotFound() })
	return a
}
func Unavailable() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteError(w, httpx.Fail(503, "contacts_store_unavailable", "The contacts database is not available"), "contacts")
	})
}
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a.mux.ServeHTTP(w, r)
}
func (a *API) authenticate(r *http.Request) (identity.Identity, string, error) {
	caller, bearer, err := a.identity.Authenticate(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		if errors.Is(err, identity.ErrUnavailable) {
			return caller, "", httpx.Fail(503, "identity_unavailable", "The identity provider is temporarily unavailable")
		}
		if errors.Is(err, identity.ErrRawKeyNotAccepted) {
			return caller, "", httpx.Fail(401, "raw_key_not_accepted", "Exchange the access key for an assertion before calling this API")
		}
		return caller, "", httpx.Fail(401, "unauthenticated", "A valid bearer token is required")
	}
	if caller.Principal.Kind == "key" {
		if a.options.ProjectID == "" || caller.Principal.Project != a.options.ProjectID {
			return caller, "", httpx.Fail(401, "unauthenticated", "A valid bearer token is required")
		}
		scope := "contacts:read"
		if r.Method != http.MethodGet {
			scope = "contacts:write"
		}
		if !slices.Contains(caller.Principal.Scopes, scope) {
			return caller, "", httpx.Fail(403, "insufficient_scope", "The access key does not permit this operation")
		}
	}
	return caller, bearer, nil
}
func (a *API) route(pattern string, mutation, needsRoles bool, fn endpoint) {
	a.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		claims, bearer, err := a.authenticate(r)
		if err != nil {
			httpx.WriteError(w, err, "contacts")
			return
		}
		s := &request{r: r, w: w, bearer: bearer, key: claims.Principal.Kind == "key", viewer: store.Viewer{ID: claims.Principal.Subject}}
		if needsRoles && !s.key {
			if a.platform == nil {
				httpx.WriteError(w, httpx.Fail(502, "upstream_unavailable", "The platform is temporarily unavailable"), "contacts")
				return
			}
			access, err := a.platform.Access(ctx, claims.Principal.Subject, bearer)
			if err != nil {
				httpx.WriteError(w, httpx.Fail(502, "upstream_unavailable", "The platform is temporarily unavailable"), "contacts")
				return
			}
			if access.NotMember {
				httpx.WriteError(w, httpx.Forbidden(), "contacts")
				return
			}
			s.viewer.Admin = access.IsConsoleAdmin
		}
		var body any
		var status int
		err = a.store.Do(ctx, mutation, func(tx *store.Tx) error {
			s.tx = tx
			if mutation {
				s.member, err = tx.UpsertMember(s.viewer.ID, claims.Name, claims.Email)
			} else {
				s.member, err = tx.Member(s.viewer.ID)
				if errors.Is(err, sql.ErrNoRows) {
					s.member = domain.Member{ID: s.viewer.ID, DisplayName: claims.Name, Email: claims.Email}
					err = nil
				}
			}
			if err != nil {
				return err
			}
			if mutation && !s.key && a.links != nil && (s.member.DirectoryCheckedAt == nil || time.Since(*s.member.DirectoryCheckedAt) > 5*time.Minute) {
				var me directory.MeResponse
				var person *string
				name := s.member.DisplayName
				lookupCtx, lookupCancel := context.WithTimeout(ctx, 3*time.Second)
				lookupErr := a.links.Do(lookupCtx, bearer, directory.Me, link.Params{}, nil, &me)
				lookupCancel()
				if lookupErr == nil && me.Person.ID != "" {
					person = &me.Person.ID
					name = me.Person.DisplayName
				} else {
					person = s.member.DirectoryPersonID
				}
				s.member, err = tx.RefreshDirectory(s.viewer.ID, person, name)
				if err != nil {
					return err
				}
			}
			body, status, err = fn(s)
			if err == nil && a.options.OCRQueue != nil {
				// Hand over the credential before this transaction commits. Writes
				// are serialized, so a worker claim that queued behind this request
				// runs the instant it commits and would find the card with no
				// credential, recording it unavailable.
				for _, id := range s.ocrCardIDs {
					a.options.OCRQueue.Enqueue(id, s.bearer)
				}
			}
			return err
		})
		if err != nil {
			if a.options.OCRQueue != nil {
				for _, id := range s.ocrCardIDs {
					a.options.OCRQueue.Forget(id)
				}
			}
			httpx.WriteError(w, err, "contacts")
			return
		}
		if len(s.ocrCardIDs) > 0 && a.options.OCRQueue != nil {
			a.options.OCRQueue.Kick()
		}
		if s.settings != nil && a.options.OnSettingsChanged != nil {
			a.options.OnSettingsChanged(*s.settings)
		}
		if raw, ok := body.(rawResponse); ok {
			w.Header().Set("Content-Type", raw.contentType)
			if raw.cacheControl != "" {
				w.Header().Set("Cache-Control", raw.cacheControl)
			}
			if raw.disposition != "" {
				w.Header().Set("Content-Disposition", raw.disposition)
			}
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(status)
			_, _ = w.Write(raw.body)
			return
		}
		if status == 204 {
			w.WriteHeader(status)
			return
		}
		httpx.WriteJSON(w, status, body)
	})
}
func decode(s *request, target any) error {
	mediaType, _, err := mime.ParseMediaType(s.r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return httpx.Invalid("Content-Type must be application/json")
	}
	body, err := io.ReadAll(http.MaxBytesReader(s.w, s.r.Body, 256<<10))
	if err != nil {
		return httpx.Invalid("Request body exceeds the size limit")
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		return httpx.Invalid("Request body must be a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(target); err != nil {
		return httpx.Invalid("Request body contains invalid or unknown fields")
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return httpx.Invalid("Request body must contain one JSON object")
	}
	return nil
}
func requireAdmin(s *request) error {
	if s.key {
		return httpx.Fail(403, "key_not_permitted", "Access keys cannot administer contacts")
	}
	if !s.viewer.Admin {
		return httpx.Forbidden()
	}
	return nil
}
