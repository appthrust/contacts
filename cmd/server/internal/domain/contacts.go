package domain

import (
	"reflect"
	"strings"
	"time"
	"unicode"

	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"golang.org/x/text/unicode/norm"
)

type Member struct {
	ID                 string     `json:"id"`
	DisplayName        string     `json:"displayName"`
	Email              string     `json:"email"`
	DirectoryPersonID  *string    `json:"directoryPersonId"`
	DirectoryCheckedAt *time.Time `json:"-"`
}
type Company struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Domain       *string   `json:"domain"`
	Address      *string   `json:"address"`
	URL          *string   `json:"url"`
	ContactCount int       `json:"contactCount"`
	MergedIntoID *string   `json:"mergedIntoId"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}
type CompanyRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type TagRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Tag struct {
	TagRef
	OwnerMemberID *string `json:"ownerMemberId"`
}
type ContactSummary struct {
	ID             string      `json:"id"`
	FullName       string      `json:"fullName"`
	Kana           *string     `json:"kana"`
	Title          *string     `json:"title"`
	Department     *string     `json:"department"`
	Company        *CompanyRef `json:"company"`
	PrimaryEmail   *string     `json:"primaryEmail"`
	Visibility     string      `json:"visibility"`
	State          string      `json:"state"`
	Tags           []TagRef    `json:"tags"`
	EncounterCount int         `json:"encounterCount"`
	KnownByMe      bool        `json:"knownByMe"`
	LastMetAt      *time.Time  `json:"lastMetAt"`
	UpdatedAt      time.Time   `json:"updatedAt"`
}
type Contact struct {
	ContactSummary
	Emails       []string        `json:"emails"`
	Phones       []string        `json:"phones"`
	Address      *string         `json:"address"`
	Notes        *string         `json:"notes"`
	CreatedBy    Member          `json:"createdBy"`
	RegisteredBy string          `json:"registeredBy"`
	Version      int             `json:"version"`
	CreatedAt    time.Time       `json:"createdAt"`
	Cards        []BusinessCard  `json:"cards"`
	Encounters   []Encounter     `json:"encounters"`
	Changes      []ContactChange `json:"changes"`
	CompanyID    *string         `json:"-"`
}
type Sheet struct {
	ID          string    `json:"id"`
	Owner       Member    `json:"owner"`
	ContentType string    `json:"contentType"`
	Detected    int       `json:"detected"`
	CreatedAt   time.Time `json:"createdAt"`
	Image       []byte    `json:"-"`
}
type BusinessCard struct {
	ID             string          `json:"id"`
	ContactID      *string         `json:"contactId"`
	Owner          Member          `json:"owner"`
	ImageURL       string          `json:"imageUrl"`
	SheetID        *string         `json:"sheetId"`
	BBox           *[4]int         `json:"bbox"`
	OCRState       string          `json:"ocrState"`
	Extraction     *ocr.Extraction `json:"extraction"`
	Decision       *string         `json:"decision"`
	DecisionReason *string         `json:"decisionReason"`
	OCRError       *string         `json:"ocrError"`
	ExchangedAt    *time.Time      `json:"exchangedAt"`
	Place          *string         `json:"place"`
	CreatedAt      time.Time       `json:"createdAt"`
}
type Encounter struct {
	Member    Member    `json:"member"`
	FirstAt   time.Time `json:"firstAt"`
	LastAt    time.Time `json:"lastAt"`
	CardCount int       `json:"cardCount"`
}
type ValueChange struct {
	From any `json:"from"`
	To   any `json:"to"`
}
type Diff map[string]ValueChange

type ContactChange struct {
	ID     string    `json:"id"`
	Actor  Member    `json:"actor"`
	At     time.Time `json:"at"`
	Diff   Diff      `json:"diff"`
	Source string    `json:"source"`
}
type DuplicateCandidate struct {
	Contacts [2]ContactSummary `json:"contacts"`
	Reason   string            `json:"reason"`
}
type Counts struct {
	MyCards    int `json:"myCards"`
	MyContacts int `json:"myContacts"`
	Contacts   int `json:"contacts"`
	Companies  int `json:"companies"`
}

// ContactInput is also the PATCH shape. A supplied empty string clears an
// optional scalar; omitted and null properties leave it unchanged on PATCH.
type ContactInput struct {
	FullName    *string   `json:"fullName"`
	Kana        *string   `json:"kana"`
	CompanyID   *string   `json:"companyId"`
	CompanyName *string   `json:"companyName"`
	Title       *string   `json:"title"`
	Department  *string   `json:"department"`
	Emails      *[]string `json:"emails"`
	Phones      *[]string `json:"phones"`
	Address     *string   `json:"address"`
	Notes       *string   `json:"notes"`
	Visibility  *string   `json:"visibility"`
}
type CompanyInput struct {
	Name    *string `json:"name"`
	Domain  *string `json:"domain"`
	Address *string `json:"address"`
	URL     *string `json:"url"`
}

func Nullable(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}
func NormalizeName(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, norm.NFKC.String(s))
}
func EmailDomain(email string) string {
	_, domain, ok := strings.Cut(strings.ToLower(strings.TrimSpace(email)), "@")
	if !ok || strings.Contains(domain, "@") {
		return ""
	}
	return domain
}
func EmailDomains(emails []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, email := range emails {
		if d := EmailDomain(email); d != "" && !seen[d] {
			out = append(out, d)
			seen[d] = true
		}
	}
	return out
}
func DuplicateReason(a, b Contact) string {
	if a.ID == b.ID || NormalizeName(a.FullName) == "" || NormalizeName(a.FullName) != NormalizeName(b.FullName) {
		return ""
	}
	for _, x := range EmailDomains(a.Emails) {
		for _, y := range EmailDomains(b.Emails) {
			if x == y {
				return "name_domain"
			}
		}
	}
	if a.Company != nil && b.Company != nil && a.Company.ID == b.Company.ID {
		return "name_company"
	}
	return ""
}
func ContactDiff(before, after Contact) Diff {
	out := Diff{}
	pairs := []struct {
		key      string
		from, to any
	}{
		{"fullName", before.FullName, after.FullName}, {"kana", before.Kana, after.Kana},
		{"companyId", before.CompanyID, after.CompanyID}, {"title", before.Title, after.Title},
		{"department", before.Department, after.Department}, {"emails", before.Emails, after.Emails},
		{"phones", before.Phones, after.Phones}, {"address", before.Address, after.Address},
		{"notes", before.Notes, after.Notes}, {"visibility", before.Visibility, after.Visibility},
		{"state", before.State, after.State},
	}
	for _, p := range pairs {
		if !reflect.DeepEqual(p.from, p.to) {
			out[p.key] = ValueChange{p.from, p.to}
		}
	}
	return out
}
