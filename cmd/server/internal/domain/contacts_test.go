package domain

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizationAndDuplicateRules(t *testing.T) {
	require.Equal(t, "abc山田", NormalizeName(" ＡＢＣ　山 田 "))
	require.Equal(t, "ガ", NormalizeName("ｶﾞ"))
	require.Equal(t, "example.test", EmailDomain(" USER@Example.Test "))
	require.Empty(t, EmailDomain("invalid"))
	a := Contact{ContactSummary: ContactSummary{ID: "a", FullName: "山田　太郎", Company: &CompanyRef{ID: "one"}}, Emails: []string{"a@example.test"}}
	b := Contact{ContactSummary: ContactSummary{ID: "b", FullName: "山田 太郎", Company: &CompanyRef{ID: "one"}}, Emails: []string{"b@example.test"}}
	require.Equal(t, "name_domain", DuplicateReason(a, b))
	b.Emails = []string{"b@other.test"}
	require.Equal(t, "name_company", DuplicateReason(a, b))
	b.Company = &CompanyRef{ID: "two"}
	require.Empty(t, DuplicateReason(a, b))
	b.FullName = "Other"
	b.Emails = a.Emails
	require.Empty(t, DuplicateReason(a, b))
	require.Empty(t, DuplicateReason(a, a))
}
func TestContactDiff(t *testing.T) {
	before := Contact{ContactSummary: ContactSummary{FullName: "Before", Visibility: "shared"}, Emails: []string{"a@example.test"}}
	after := before
	after.FullName = "After"
	after.Notes = Nullable(" A note ")
	diff := ContactDiff(before, after)
	require.Len(t, diff, 2)
	require.Equal(t, ValueChange{From: "Before", To: "After"}, diff["fullName"])
	require.Empty(t, ContactDiff(after, after))
}
