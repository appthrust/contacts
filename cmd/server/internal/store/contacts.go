package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/resolve"
	"github.com/lib/pq"
	"github.com/oklog/ulid/v2"
)

const contactSelect = `SELECT c.id,c.full_name,c.kana,c.title,c.department,c.company_id,
 co.id,co.name,c.visibility,c.state,c.updated_at,c.emails,c.phones,c.address,c.notes,c.version,c.created_at,
 m.sub,m.display_name,m.email,m.directory_person_id,c.registered_by,
 (SELECT count(*) FROM encounters e WHERE e.contact_id=c.id),
 EXISTS(SELECT 1 FROM encounters e WHERE e.contact_id=c.id AND e.member_id=$1),
 (SELECT max(e.last_at) FROM encounters e WHERE e.contact_id=c.id),
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name) ORDER BY g.name,g.id) FROM contact_tags ct JOIN tags g ON g.id=ct.tag_id WHERE ct.contact_id=c.id AND (g.owner_member_id IS NULL OR g.owner_member_id=$1 OR $2)), '[]'::jsonb)
 FROM contacts c JOIN members m ON m.sub=c.created_by_member_id
 LEFT JOIN companies co ON co.id=contacts_company_root(c.company_id) `

func scanContact(row scanner) (c domain.Contact, err error) {
	var companyID, companyName *string
	var tags []byte
	err = row.Scan(&c.ID, &c.FullName, &c.Kana, &c.Title, &c.Department, &c.CompanyID,
		&companyID, &companyName, &c.Visibility, &c.State, &c.UpdatedAt, pq.Array(&c.Emails), pq.Array(&c.Phones), &c.Address, &c.Notes, &c.Version, &c.CreatedAt,
		&c.CreatedBy.ID, &c.CreatedBy.DisplayName, &c.CreatedBy.Email, &c.CreatedBy.DirectoryPersonID, &c.RegisteredBy,
		&c.EncounterCount, &c.KnownByMe, &c.LastMetAt, &tags)
	if err != nil {
		return
	}
	c.CreatedAt = c.CreatedAt.UTC()
	c.UpdatedAt = c.UpdatedAt.UTC()
	if c.LastMetAt != nil {
		at := c.LastMetAt.UTC()
		c.LastMetAt = &at
	}
	if companyID != nil {
		c.Company = &domain.CompanyRef{ID: *companyID, Name: *companyName}
	}
	if len(c.Emails) > 0 {
		c.PrimaryEmail = &c.Emails[0]
	}
	c.Cards = []domain.BusinessCard{}
	c.Encounters = []domain.Encounter{}
	c.Changes = []domain.ContactChange{}
	err = json.Unmarshal(tags, &c.Tags)
	return
}
func (t *Tx) contact(id string, v Viewer) (domain.Contact, error) {
	return scanContact(t.SQL.QueryRowContext(t.Context, contactSelect+`WHERE c.id=$3 AND `+visibleContact, v.ID, v.Admin, id))
}
func (t *Tx) Contact(id string, v Viewer) (domain.Contact, error) {
	c, err := t.contact(id, v)
	if err != nil {
		return c, err
	}
	c.Cards, err = t.contactCards(id, v)
	if err != nil {
		return c, err
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT m.sub,m.display_name,m.email,m.directory_person_id,e.first_at,e.last_at,e.card_count FROM encounters e JOIN members m ON m.sub=e.member_id WHERE e.contact_id=$1 ORDER BY e.last_at DESC,m.sub`, id)
	if err != nil {
		return c, err
	}
	for rows.Next() {
		var e domain.Encounter
		if err = rows.Scan(&e.Member.ID, &e.Member.DisplayName, &e.Member.Email, &e.Member.DirectoryPersonID, &e.FirstAt, &e.LastAt, &e.CardCount); err != nil {
			rows.Close()
			return c, err
		}
		e.FirstAt = e.FirstAt.UTC()
		e.LastAt = e.LastAt.UTC()
		c.Encounters = append(c.Encounters, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return c, err
	}
	rows, err = t.SQL.QueryContext(t.Context, `SELECT h.id,m.sub,m.display_name,m.email,m.directory_person_id,h.at,h.diff,h.source FROM contact_changes h JOIN members m ON m.sub=h.actor_member_id WHERE h.contact_id=$1 ORDER BY h.at DESC,h.id DESC`, id)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	for rows.Next() {
		var change domain.ContactChange
		var raw []byte
		if err := rows.Scan(&change.ID, &change.Actor.ID, &change.Actor.DisplayName, &change.Actor.Email, &change.Actor.DirectoryPersonID, &change.At, &raw, &change.Source); err != nil {
			return c, err
		}
		if err := json.Unmarshal(raw, &change.Diff); err != nil {
			return c, err
		}
		change.At = change.At.UTC()
		c.Changes = append(c.Changes, change)
	}
	return c, rows.Err()
}

type ContactOptions struct {
	Viewer
	Limit                                                     int
	Cursor, Query, CompanyID, Tag, KnownBy, State, Visibility string
	UpdatedAfter                                              *time.Time
	ByLastMet                                                 bool
}

func (t *Tx) Contacts(o ContactOptions) (Page[domain.ContactSummary], error) {
	page := Page[domain.ContactSummary]{Items: []domain.ContactSummary{}}
	at, id, err := cursorArgs(o.Cursor)
	if err != nil {
		return page, err
	}
	order := "c.updated_at"
	if o.ByLastMet {
		order = "(SELECT e.last_at FROM encounters e WHERE e.contact_id=c.id AND e.member_id=$1)"
	}
	rows, err := t.SQL.QueryContext(t.Context, contactSelect+`WHERE `+visibleContact+`
	 AND (($3='' AND c.state<>'archived') OR c.state=$3)
	 AND ($4='' OR c.search @@ plainto_tsquery('simple',$4) OR c.full_name ILIKE '%'||$4||'%' OR coalesce(c.kana,'') ILIKE '%'||$4||'%' OR coalesce(co.name,'') ILIKE '%'||$4||'%' OR contacts_email_text(c.emails) ILIKE '%'||$4||'%')
	 AND ($5='' OR co.id=contacts_company_root($5))
	 AND ($6='' OR EXISTS(SELECT 1 FROM contact_tags ct JOIN tags g ON g.id=ct.tag_id WHERE ct.contact_id=c.id AND g.id=$6 AND (g.owner_member_id IS NULL OR g.owner_member_id=$1 OR $2)))
	 AND ($7='' OR EXISTS(SELECT 1 FROM encounters e WHERE e.contact_id=c.id AND e.member_id=$7))
	 AND ($8='' OR c.visibility=$8)
	 AND ($9::timestamptz IS NULL OR c.updated_at>$9)
	 AND ($10::timestamptz IS NULL OR (`+order+`,c.id)<($10::timestamptz,$11))
	 ORDER BY `+order+` DESC,c.id DESC LIMIT $12`, o.ID, o.Admin, o.State, o.Query, o.CompanyID, o.Tag, o.KnownBy, o.Visibility, o.UpdatedAfter, at, id, o.Limit+1)
	if err != nil {
		return page, err
	}
	for rows.Next() {
		c, err := scanContact(rows)
		if err != nil {
			rows.Close()
			return page, err
		}
		page.Items = append(page.Items, c.ContactSummary)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return page, err
	}
	if len(page.Items) > o.Limit {
		page.Items = page.Items[:o.Limit]
		last := page.Items[o.Limit-1]
		cursorAt := last.UpdatedAt
		if o.ByLastMet {
			if err := t.SQL.QueryRowContext(t.Context, `SELECT last_at FROM encounters WHERE contact_id=$1 AND member_id=$2`, last.ID, o.ID).Scan(&cursorAt); err != nil {
				return page, err
			}
		}
		page.NextCursor = nextCursor(cursorAt, last.ID)
	}
	return page, nil
}
func (t *Tx) applyContact(c *domain.Contact, input domain.ContactInput, v Viewer) error {
	if input.FullName != nil {
		c.FullName = strings.TrimSpace(*input.FullName)
	}
	if c.FullName == "" {
		return httpx.Invalid("Full name is required")
	}
	for _, p := range []struct {
		in  *string
		out **string
	}{
		{input.Kana, &c.Kana}, {input.Title, &c.Title}, {input.Department, &c.Department}, {input.Address, &c.Address}, {input.Notes, &c.Notes},
	} {
		if p.in != nil {
			*p.out = domain.Nullable(*p.in)
		}
	}
	if input.Visibility != nil {
		c.Visibility = *input.Visibility
	}
	if c.Visibility != "shared" && c.Visibility != "private" {
		return httpx.Invalid("Visibility must be shared or private")
	}
	if input.Emails != nil {
		c.Emails = cleanValues(*input.Emails)
	}
	if input.Phones != nil {
		c.Phones = cleanValues(*input.Phones)
	}
	if input.CompanyID != nil {
		c.CompanyID = domain.Nullable(*input.CompanyID)
		if c.CompanyID != nil {
			company, err := t.Company(*c.CompanyID, v)
			if err != nil {
				return err
			}
			c.CompanyID = &company.ID
		}
	} else if input.CompanyName != nil {
		c.CompanyID = nil
		if name := strings.TrimSpace(*input.CompanyName); name != "" {
			company, err := t.EnsureCompany(name, v)
			if err != nil {
				return err
			}
			c.CompanyID = &company.ID
		}
	}
	return nil
}
func cleanValues(in []string) []string {
	out := make([]string, 0, len(in))
	for _, value := range in {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}
func (t *Tx) CreateContact(input domain.ContactInput, v Viewer) (domain.Contact, error) {
	c := domain.Contact{ContactSummary: domain.ContactSummary{ID: ulid.Make().String(), Visibility: "shared", State: "active"}, Emails: []string{}, Phones: []string{}}
	if err := t.applyContact(&c, input, v); err != nil {
		return c, err
	}
	err := t.Exec(`INSERT INTO contacts(id,company_id,company_search,full_name,normalized_name,kana,title,department,emails,email_domains,phones,address,notes,visibility,state,created_by_member_id,registered_by)
	 VALUES($1,$2,coalesce((SELECT name FROM companies WHERE id=contacts_company_root($2)),''),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		c.ID, c.CompanyID, c.FullName, domain.NormalizeName(c.FullName), c.Kana, c.Title, c.Department, pq.Array(c.Emails), pq.Array(domain.EmailDomains(c.Emails)), pq.Array(c.Phones), c.Address, c.Notes, c.Visibility, c.State, v.ID, t.source)
	if err != nil {
		return c, err
	}
	if err = t.recordChange(c.ID, v.ID, domain.ContactDiff(domain.Contact{}, c), false); err != nil {
		return c, err
	}
	return t.Contact(c.ID, v)
}
func (t *Tx) PatchContact(id string, input domain.ContactInput, version int, v Viewer) (domain.Contact, error) {
	before, err := t.contact(id, v)
	if err != nil {
		return before, err
	}
	if err = CheckVersion(before, version); err != nil {
		return before, err
	}
	after := before
	if err = t.applyContact(&after, input, v); err != nil {
		return before, err
	}
	err = t.Exec(`UPDATE contacts SET company_id=$2,company_search=coalesce((SELECT name FROM companies WHERE id=contacts_company_root($2)),''),full_name=$3,normalized_name=$4,kana=$5,title=$6,department=$7,emails=$8,email_domains=$9,phones=$10,address=$11,notes=$12,visibility=$13 WHERE id=$1`,
		id, after.CompanyID, after.FullName, domain.NormalizeName(after.FullName), after.Kana, after.Title, after.Department, pq.Array(after.Emails), pq.Array(domain.EmailDomains(after.Emails)), pq.Array(after.Phones), after.Address, after.Notes, after.Visibility)
	if err != nil {
		return before, err
	}
	if err = t.recordChange(id, v.ID, domain.ContactDiff(before, after), true); err != nil {
		return before, err
	}
	return t.Contact(id, v)
}
func (t *Tx) ArchiveContact(id string, version int, v Viewer) error {
	c, err := t.contact(id, v)
	if err != nil {
		return err
	}
	if !v.Admin && c.CreatedBy.ID != v.ID {
		return httpx.Forbidden()
	}
	if err = CheckVersion(c, version); err != nil {
		return err
	}
	if err = t.Exec(`UPDATE contacts SET state='archived' WHERE id=$1`, id); err != nil {
		return err
	}
	return t.recordChange(id, v.ID, domain.Diff{"state": {From: c.State, To: "archived"}}, true)
}
func (t *Tx) MergeContacts(target, source string, version int, v Viewer) (domain.Contact, error) {
	if target == source {
		return domain.Contact{}, httpx.Invalid("Cannot merge a contact into itself")
	}
	a, err := t.contact(target, v)
	if err != nil {
		return a, err
	}
	b, err := t.contact(source, v)
	if err != nil {
		return a, err
	}
	if err = CheckVersion(a, version); err != nil {
		return a, err
	}
	if a.State == "archived" || b.State == "archived" {
		return a, httpx.Conflict("Archived contacts cannot be merged")
	}
	if !v.Admin {
		var others bool
		err = t.SQL.QueryRowContext(t.Context, `SELECT EXISTS(SELECT 1 FROM cards WHERE contact_id IN ($1,$2) AND owner_member_id<>$3)`, target, source, v.ID).Scan(&others)
		if err != nil {
			return a, err
		}
		if others {
			return a, httpx.Forbidden()
		}
	}
	if err = t.Exec(`UPDATE cards SET contact_id=$1 WHERE contact_id=$2`, target, source); err != nil {
		return a, err
	}
	if err = t.Exec(`INSERT INTO contact_tags(contact_id,tag_id) SELECT $1,tag_id FROM contact_tags WHERE contact_id=$2 ON CONFLICT DO NOTHING`, target, source); err != nil {
		return a, err
	}
	if err = t.Exec(`DELETE FROM contact_tags WHERE contact_id=$1`, source); err != nil {
		return a, err
	}
	if err = t.Exec(`UPDATE contacts SET state='archived' WHERE id=$1`, source); err != nil {
		return a, err
	}
	for _, id := range []string{target, source} {
		if err = t.recomputeEncounters(id); err != nil {
			return a, err
		}
	}
	if err = t.recordChange(target, v.ID, domain.Diff{"mergedFrom": {From: nil, To: source}}, true); err != nil {
		return a, err
	}
	if err = t.recordChange(source, v.ID, domain.Diff{"state": {From: b.State, To: "archived"}, "mergedInto": {From: nil, To: target}}, true); err != nil {
		return a, err
	}
	return t.Contact(target, v)
}
func (t *Tx) Duplicates(limit int, v Viewer) ([]domain.DuplicateCandidate, error) {
	rows, err := t.SQL.QueryContext(t.Context, `SELECT c.id,b.id FROM contacts c JOIN contacts b ON c.id<b.id AND c.normalized_name=b.normalized_name
	 WHERE c.state<>'archived' AND b.state<>'archived' AND `+visibleContact+`
	 AND (b.visibility='shared' OR b.created_by_member_id=$1 OR $2 OR EXISTS(SELECT 1 FROM cards own WHERE own.contact_id=b.id AND own.owner_member_id=$1))
	 AND (c.email_domains && b.email_domains OR (c.company_id IS NOT NULL AND contacts_company_root(c.company_id)=contacts_company_root(b.company_id)))
	 ORDER BY c.id,b.id LIMIT $3`, v.ID, v.Admin, limit)
	if err != nil {
		return nil, err
	}
	pairs := [][2]string{}
	for rows.Next() {
		var p [2]string
		if err = rows.Scan(&p[0], &p[1]); err != nil {
			rows.Close()
			return nil, err
		}
		pairs = append(pairs, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := []domain.DuplicateCandidate{}
	for _, p := range pairs {
		a, err := t.contact(p[0], v)
		if err != nil {
			return nil, err
		}
		b, err := t.contact(p[1], v)
		if err != nil {
			return nil, err
		}
		out = append(out, domain.DuplicateCandidate{Contacts: [2]domain.ContactSummary{a.ContactSummary, b.ContactSummary}, Reason: domain.DuplicateReason(a, b)})
	}
	return out, nil
}

var _ resolve.Reader = (*Tx)(nil)

func (t *Tx) ContactsByEmail(emails []string) ([]domain.ContactSummary, error) {
	normalized := make([]string, 0, len(emails))
	for _, email := range emails {
		if email = strings.ToLower(strings.TrimSpace(email)); email != "" {
			normalized = append(normalized, email)
		}
	}
	return t.resolveContacts(`EXISTS(SELECT 1 FROM unnest(c.emails) AS email WHERE lower(btrim(email))=ANY($3::text[]))`, pq.Array(normalized))
}

func (t *Tx) ContactsByNormalizedName(name string) ([]domain.ContactSummary, error) {
	return t.resolveContacts(`c.normalized_name=$3`, domain.NormalizeName(name))
}

func (t *Tx) resolveContacts(predicate string, value any) ([]domain.ContactSummary, error) {
	rows, err := t.SQL.QueryContext(t.Context, contactSelect+`WHERE c.state<>'archived' AND `+visibleContact+` AND `+predicate+` ORDER BY c.id`, t.Viewer.ID, t.Viewer.Admin, value)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.ContactSummary{}
	for rows.Next() {
		c, err := scanContact(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c.ContactSummary)
	}
	return out, rows.Err()
}

func (t *Tx) CompanyByNormalizedName(name string) (*domain.Company, error) {
	return t.resolveCompany(`candidate.normalized_name=$3`, domain.NormalizeName(name))
}

func (t *Tx) CompanyByDomain(name string) (*domain.Company, error) {
	return t.resolveCompany(`lower(btrim(candidate.domain))=$3`, strings.ToLower(strings.TrimSpace(name)))
}

func (t *Tx) resolveCompany(predicate, value string) (*domain.Company, error) {
	c, err := scanCompany(t.SQL.QueryRowContext(t.Context, companySelect+`WHERE co.id=(SELECT contacts_company_root(candidate.id) FROM companies candidate WHERE `+predicate+` ORDER BY (candidate.merged_into_id IS NULL) DESC,candidate.created_at,candidate.id LIMIT 1)`, t.Viewer.ID, t.Viewer.Admin, value))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}
