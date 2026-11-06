// Package resolve matches an immutable extraction against visible contacts and
// companies. It never writes or chooses a registration policy.
package resolve

import (
	"sort"
	"strings"

	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
)

type Candidate struct {
	ContactID string
	Score     float64
	Reason    string
}

type Resolution struct {
	Contacts    []Candidate
	CompanyID   *string
	CompanyName string
}

type Reader interface {
	ContactsByEmail(emails []string) ([]domain.ContactSummary, error)
	ContactsByNormalizedName(name string) ([]domain.ContactSummary, error)
	CompanyByNormalizedName(name string) (*domain.Company, error)
	CompanyByDomain(domain string) (*domain.Company, error)
}

func Resolve(r Reader, x ocr.Extraction) (Resolution, error) {
	out := Resolution{Contacts: []Candidate{}, CompanyName: strings.TrimSpace(x.Fields.Company)}
	var company *domain.Company
	var err error
	if name := domain.NormalizeName(out.CompanyName); name != "" {
		company, err = r.CompanyByNormalizedName(name)
		if err != nil {
			return out, err
		}
	}
	if company == nil {
		for _, d := range domain.EmailDomains(x.Fields.Emails) {
			if freeMail(d) {
				continue
			}
			company, err = r.CompanyByDomain(d)
			if err != nil {
				return out, err
			}
			if company != nil {
				break
			}
		}
	}
	if company != nil {
		out.CompanyID = &company.ID
	}
	seen := make(map[string]bool)
	if len(x.Fields.Emails) > 0 {
		contacts, err := r.ContactsByEmail(x.Fields.Emails)
		if err != nil {
			return out, err
		}
		for _, c := range contacts {
			if !seen[c.ID] {
				out.Contacts = append(out.Contacts, Candidate{ContactID: c.ID, Score: 1, Reason: "email"})
				seen[c.ID] = true
			}
		}
	}
	if name := domain.NormalizeName(x.Fields.FullName); name != "" {
		contacts, err := r.ContactsByNormalizedName(name)
		if err != nil {
			return out, err
		}
		for _, c := range contacts {
			if seen[c.ID] {
				continue
			}
			candidate := Candidate{ContactID: c.ID, Score: 0.6, Reason: "name"}
			if out.CompanyID != nil && c.Company != nil && c.Company.ID == *out.CompanyID {
				candidate.Score, candidate.Reason = 0.95, "name_company"
			}
			out.Contacts = append(out.Contacts, candidate)
			seen[c.ID] = true
		}
	}
	sort.Slice(out.Contacts, func(i, j int) bool {
		if out.Contacts[i].Score == out.Contacts[j].Score {
			return out.Contacts[i].ContactID < out.Contacts[j].ContactID
		}
		return out.Contacts[i].Score > out.Contacts[j].Score
	})
	return out, nil
}

func freeMail(d string) bool {
	switch d {
	case "gmail.com", "yahoo.com", "yahoo.co.jp", "outlook.com", "hotmail.com", "icloud.com":
		return true
	}
	return false
}
