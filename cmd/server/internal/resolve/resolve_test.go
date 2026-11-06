package resolve

import (
	"errors"
	"testing"

	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/stretchr/testify/require"
)

type fakeReader struct {
	emails, names            []domain.ContactSummary
	company, domainCompany   *domain.Company
	companyName, contactName string
	domains                  []string
	fail                     string
}

var errRead = errors.New("read failed")

func (r *fakeReader) ContactsByEmail([]string) ([]domain.ContactSummary, error) {
	if r.fail == "email" {
		return nil, errRead
	}
	return r.emails, nil
}
func (r *fakeReader) ContactsByNormalizedName(name string) ([]domain.ContactSummary, error) {
	r.contactName = name
	if r.fail == "name" {
		return nil, errRead
	}
	return r.names, nil
}
func (r *fakeReader) CompanyByNormalizedName(name string) (*domain.Company, error) {
	r.companyName = name
	if r.fail == "company" {
		return nil, errRead
	}
	return r.company, nil
}
func (r *fakeReader) CompanyByDomain(name string) (*domain.Company, error) {
	r.domains = append(r.domains, name)
	if r.fail == "domain" {
		return nil, errRead
	}
	return r.domainCompany, nil
}

func TestResolveScoresAndNormalization(t *testing.T) {
	company := &domain.Company{ID: "co", Name: "Acme"}
	r := &fakeReader{
		company: company,
		emails:  []domain.ContactSummary{{ID: "email"}, {ID: "email"}},
		names: []domain.ContactSummary{
			{ID: "name"}, {ID: "company", Company: &domain.CompanyRef{ID: "co"}},
			{ID: "email", Company: &domain.CompanyRef{ID: "co"}},
			{ID: "other-company", Company: &domain.CompanyRef{ID: "other"}},
		},
	}
	got, err := Resolve(r, ocr.Extraction{Fields: ocr.Fields{FullName: " Ａｏｉ　Tanaka ", Company: " ＡＣＭＥ ", Emails: []string{"a@acme.test"}}})
	require.NoError(t, err)
	require.Equal(t, "aoi田中", domain.NormalizeName("ＡＯＩ 田中"))
	require.Equal(t, "aoitanaka", r.contactName)
	require.Equal(t, "acme", r.companyName)
	require.Equal(t, "ＡＣＭＥ", got.CompanyName)
	require.Equal(t, &company.ID, got.CompanyID)
	require.Empty(t, r.domains, "company name takes precedence over email domain")
	require.Equal(t, []Candidate{
		{ContactID: "email", Score: 1, Reason: "email"},
		{ContactID: "company", Score: .95, Reason: "name_company"},
		{ContactID: "name", Score: .6, Reason: "name"},
		{ContactID: "other-company", Score: .6, Reason: "name"},
	}, got.Contacts)
}

func TestResolveCompanyDomainAndFreeMail(t *testing.T) {
	r := &fakeReader{domainCompany: &domain.Company{ID: "domain"}}
	got, err := Resolve(r, ocr.Extraction{Fields: ocr.Fields{Company: " Unknown ", Emails: []string{
		"a@gmail.com", "b@yahoo.com", "c@yahoo.co.jp", "d@outlook.com", "e@hotmail.com", "f@icloud.com", "invalid", " User@Acme.Test ",
	}}})
	require.NoError(t, err)
	require.Equal(t, []string{"acme.test"}, r.domains)
	require.Equal(t, "domain", *got.CompanyID)
	require.Equal(t, "Unknown", got.CompanyName)
	r = &fakeReader{}
	got, err = Resolve(r, ocr.Extraction{Fields: ocr.Fields{Company: " New Company ", Emails: []string{"a@gmail.com"}}})
	require.NoError(t, err)
	require.Nil(t, got.CompanyID)
	require.Equal(t, "New Company", got.CompanyName)
	require.Empty(t, got.Contacts)
	require.Empty(t, r.domains)
}

func TestResolvePropagatesReadErrors(t *testing.T) {
	for _, point := range []string{"company", "domain", "email", "name"} {
		t.Run(point, func(t *testing.T) {
			_, err := Resolve(&fakeReader{fail: point}, ocr.Extraction{Fields: ocr.Fields{FullName: "Name", Company: "Company", Emails: []string{"a@example.test"}}})
			require.ErrorIs(t, err, errRead)
		})
	}
}
