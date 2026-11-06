package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/store"
)

type meResponse struct {
	Member domain.Member `json:"member"`
	Roles  struct {
		ContactsAdmin bool `json:"contactsAdmin"`
	} `json:"roles"`
	Directory struct {
		Linked    bool    `json:"linked"`
		PublicURL *string `json:"publicUrl"`
	} `json:"directory"`
	OCR struct {
		OCRModelInfo
		Available    bool   `json:"available"`
		Extractor    string `json:"extractor"`
		ReleaseModel string `json:"releaseModel"`
		SheetSplit   bool   `json:"sheetSplit"`
	} `json:"ocr"`
	Counts domain.Counts `json:"counts"`
}

func (a *API) me(s *request) (any, int, error) {
	out := meResponse{Member: s.member}
	out.Roles.ContactsAdmin = s.viewer.Admin
	out.Directory.PublicURL = domain.Nullable(a.options.DirectoryPublicURL)
	out.Directory.Linked = s.member.DirectoryPersonID != nil
	out.OCR.Available = a.options.OCR.Available
	out.OCR.Extractor = a.options.OCR.Extractor
	out.OCR.ReleaseModel = a.options.OCR.ReleaseModel
	out.OCR.SheetSplit = a.options.OCR.SheetSplit
	out.OCR.Models = []OCRModel{}
	if a.options.OCR.Probe != nil {
		out.OCR.OCRModelInfo = a.options.OCR.Probe(s.r.Context(), s.bearer)
	}
	var err error
	out.Counts, err = s.tx.Counts(s.viewer)
	return out, 200, err
}
func limit(s *request) (int, error) {
	value := s.r.URL.Query().Get("limit")
	if value == "" {
		return 20, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 || n > 100 {
		return 0, httpx.Invalid("Limit must be between 1 and 100")
	}
	return n, nil
}
func version(s *request) (int, error) {
	raw := strings.TrimSpace(s.r.Header.Get("If-Match"))
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		raw = raw[1 : len(raw)-1]
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, httpx.Invalid("If-Match must contain the contact version")
	}
	return n, nil
}
func (a *API) contactList(s *request, my bool) (any, int, error) {
	n, err := limit(s)
	if err != nil {
		return nil, 0, err
	}
	q := s.r.URL.Query()
	o := store.ContactOptions{Viewer: s.viewer, Limit: n, Cursor: q.Get("cursor"), Query: q.Get("q"), CompanyID: q.Get("companyId"), Tag: q.Get("tag"), KnownBy: q.Get("knownBy"), State: q.Get("state"), Visibility: q.Get("visibility"), ByLastMet: my}
	if o.State != "" && o.State != "active" && o.State != "draft" && o.State != "archived" {
		return nil, 0, httpx.Invalid("State must be draft, active or archived")
	}
	if o.Visibility != "" && o.Visibility != "shared" && o.Visibility != "private" {
		return nil, 0, httpx.Invalid("Visibility must be shared or private")
	}
	if my || o.KnownBy == "me" {
		o.KnownBy = s.viewer.ID
	}
	if value := q.Get("updatedAfter"); value != "" {
		at, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return nil, 0, httpx.Invalid("updatedAfter must be an RFC 3339 timestamp")
		}
		o.UpdatedAfter = &at
	}
	page, err := s.tx.Contacts(o)
	return page, 200, err
}
func (a *API) contacts(s *request) (any, int, error)   { return a.contactList(s, false) }
func (a *API) myContacts(s *request) (any, int, error) { return a.contactList(s, true) }
func (a *API) contact(s *request) (any, int, error) {
	c, err := s.tx.Contact(s.r.PathValue("id"), s.viewer)
	return c, 200, err
}
func (a *API) createContact(s *request) (any, int, error) {
	var input domain.ContactInput
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	c, err := s.tx.CreateContact(input, s.viewer)
	return c, 201, err
}
func (a *API) patchContact(s *request) (any, int, error) {
	v, err := version(s)
	if err != nil {
		return nil, 0, err
	}
	var input domain.ContactInput
	if err = decode(s, &input); err != nil {
		return nil, 0, err
	}
	c, err := s.tx.PatchContact(s.r.PathValue("id"), input, v, s.viewer)
	return c, 200, err
}
func (a *API) archiveContact(s *request) (any, int, error) {
	v, err := version(s)
	if err != nil {
		return nil, 0, err
	}
	return nil, 204, s.tx.ArchiveContact(s.r.PathValue("id"), v, s.viewer)
}
func (a *API) mergeContact(s *request) (any, int, error) {
	v, err := version(s)
	if err != nil {
		return nil, 0, err
	}
	var input struct {
		SourceID string `json:"sourceId"`
	}
	if err = decode(s, &input); err != nil {
		return nil, 0, err
	}
	if input.SourceID == "" {
		return nil, 0, httpx.Invalid("sourceId is required")
	}
	c, err := s.tx.MergeContacts(s.r.PathValue("id"), input.SourceID, v, s.viewer)
	return c, 200, err
}
func (a *API) duplicates(s *request) (any, int, error) {
	n, err := limit(s)
	if err != nil {
		return nil, 0, err
	}
	items, err := s.tx.Duplicates(n, s.viewer)
	return map[string]any{"items": items}, 200, err
}
func (a *API) contactTag(s *request) (any, int, error) {
	v, err := version(s)
	if err != nil {
		return nil, 0, err
	}
	return nil, 204, s.tx.ContactTag(s.r.PathValue("id"), s.r.PathValue("tagId"), s.r.Method == http.MethodPut, v, s.viewer)
}
func (a *API) companies(s *request) (any, int, error) {
	n, err := limit(s)
	if err != nil {
		return nil, 0, err
	}
	q := s.r.URL.Query()
	page, err := s.tx.Companies(q.Get("q"), q.Get("cursor"), n, s.viewer)
	return page, 200, err
}
func (a *API) company(s *request) (any, int, error) {
	c, err := s.tx.Company(s.r.PathValue("id"), s.viewer)
	return c, 200, err
}
func (a *API) createCompany(s *request) (any, int, error) {
	var input domain.CompanyInput
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	c, err := s.tx.CreateCompany(input, s.viewer)
	return c, 201, err
}
func (a *API) patchCompany(s *request) (any, int, error) {
	var input domain.CompanyInput
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	c, err := s.tx.PatchCompany(s.r.PathValue("id"), input, s.viewer)
	return c, 200, err
}
func (a *API) mergeCompany(s *request) (any, int, error) {
	if err := requireAdmin(s); err != nil {
		return nil, 0, err
	}
	var input struct {
		SourceID string `json:"sourceId"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if input.SourceID == "" {
		return nil, 0, httpx.Invalid("sourceId is required")
	}
	c, err := s.tx.MergeCompanies(s.r.PathValue("id"), input.SourceID, s.viewer)
	return c, 200, err
}
func (a *API) tags(s *request) (any, int, error) {
	items, err := s.tx.Tags(s.viewer)
	return map[string]any{"items": items}, 200, err
}
func (a *API) createTag(s *request) (any, int, error) {
	var input struct {
		Name   string `json:"name"`
		Shared bool   `json:"shared"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if input.Shared {
		if err := requireAdmin(s); err != nil {
			return nil, 0, err
		}
	}
	tag, err := s.tx.CreateTag(input.Name, input.Shared, s.viewer)
	return tag, 201, err
}
func (a *API) deleteTag(s *request) (any, int, error) {
	return nil, 204, s.tx.DeleteTag(s.r.PathValue("id"), s.viewer)
}
