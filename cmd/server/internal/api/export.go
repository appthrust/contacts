package api

import (
	"bytes"
	"encoding/csv"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
)

func scalar(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
func timestamp(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
func (a *API) export(s *request) (any, int, error) {
	scope := s.r.URL.Query().Get("scope")
	if scope != "" && scope != "me" && scope != "project" {
		return nil, 0, httpx.Invalid("Scope must be me or project")
	}
	if scope == "project" {
		if err := requireAdmin(s); err != nil {
			return nil, 0, err
		}
	}
	rows, err := s.tx.Export(scope == "project", s.viewer)
	if err != nil {
		return nil, 0, err
	}
	var buffer bytes.Buffer
	buffer.WriteString("\xef\xbb\xbf")
	writer := csv.NewWriter(&buffer)
	if err = writer.Write([]string{"fullName", "kana", "company", "department", "title", "emails", "phones", "address", "visibility", "firstMetAt", "lastMetAt", "metBy"}); err != nil {
		return nil, 0, err
	}
	for _, r := range rows {
		if err = writer.Write([]string{r.FullName, scalar(r.Kana), scalar(r.Company), scalar(r.Department), scalar(r.Title), strings.Join(r.Emails, "; "), strings.Join(r.Phones, "; "), scalar(r.Address), r.Visibility, timestamp(r.FirstMetAt), timestamp(r.LastMetAt), r.MetBy}); err != nil {
			return nil, 0, err
		}
	}
	writer.Flush()
	if err = writer.Error(); err != nil {
		return nil, 0, err
	}
	return rawResponse{body: buffer.Bytes(), contentType: "text/csv; charset=utf-8", disposition: `attachment; filename="contacts.csv"`}, 200, nil
}
