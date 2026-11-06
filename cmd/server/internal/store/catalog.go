package store

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

const companySelect = `SELECT co.id,co.name,co.domain,co.address,co.url,co.merged_into_id,co.created_at,co.updated_at,
 (SELECT count(*) FROM contacts c WHERE contacts_company_root(c.company_id)=co.id AND c.state<>'archived' AND ` + visibleContact + `) FROM companies co `

func scanCompany(row scanner) (c domain.Company, err error) {
	err = row.Scan(&c.ID, &c.Name, &c.Domain, &c.Address, &c.URL, &c.MergedIntoID, &c.CreatedAt, &c.UpdatedAt, &c.ContactCount)
	c.CreatedAt = c.CreatedAt.UTC()
	c.UpdatedAt = c.UpdatedAt.UTC()
	return
}
func (t *Tx) Company(id string, v Viewer) (domain.Company, error) {
	return scanCompany(t.SQL.QueryRowContext(t.Context, companySelect+`WHERE co.id=contacts_company_root($3)`, v.ID, v.Admin, id))
}
func (t *Tx) Companies(q, cursor string, limit int, v Viewer) (Page[domain.Company], error) {
	page := Page[domain.Company]{Items: []domain.Company{}}
	at, id, err := cursorArgs(cursor)
	if err != nil {
		return page, err
	}
	rows, err := t.SQL.QueryContext(t.Context, companySelect+`WHERE co.merged_into_id IS NULL AND ($3='' OR co.name ILIKE '%'||$3||'%' OR co.domain ILIKE '%'||$3||'%') AND ($4::timestamptz IS NULL OR (co.updated_at,co.id)<($4::timestamptz,$5)) ORDER BY co.updated_at DESC,co.id DESC LIMIT $6`, v.ID, v.Admin, q, at, id, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		c, err := scanCompany(rows)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, c)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		c := page.Items[limit-1]
		page.NextCursor = nextCursor(c.UpdatedAt, c.ID)
	}
	return page, nil
}
func (t *Tx) EnsureCompany(name string, v Viewer) (domain.Company, error) {
	var id string
	normalized := domain.NormalizeName(name)
	err := t.SQL.QueryRowContext(t.Context, `SELECT id FROM companies WHERE normalized_name=$1 ORDER BY (merged_into_id IS NULL) DESC,created_at,id LIMIT 1`, normalized).Scan(&id)
	if err == nil {
		return t.Company(id, v)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.Company{}, err
	}
	err = t.SQL.QueryRowContext(t.Context, `INSERT INTO companies(id,name,normalized_name) VALUES($1,$2,$3) ON CONFLICT(normalized_name) WHERE merged_into_id IS NULL DO UPDATE SET normalized_name=excluded.normalized_name RETURNING id`, ulid.Make().String(), strings.TrimSpace(name), normalized).Scan(&id)
	if err != nil {
		return domain.Company{}, err
	}
	return t.Company(id, v)
}
func applyCompany(c *domain.Company, input domain.CompanyInput) error {
	if input.Name != nil {
		c.Name = strings.TrimSpace(*input.Name)
	}
	if c.Name == "" {
		return httpx.Invalid("Company name is required")
	}
	for _, p := range []struct {
		in  *string
		out **string
	}{{input.Domain, &c.Domain}, {input.Address, &c.Address}, {input.URL, &c.URL}} {
		if p.in != nil {
			*p.out = domain.Nullable(*p.in)
		}
	}
	return nil
}
func (t *Tx) CreateCompany(input domain.CompanyInput, v Viewer) (domain.Company, error) {
	c := domain.Company{ID: ulid.Make().String()}
	if err := applyCompany(&c, input); err != nil {
		return c, err
	}
	if err := t.Exec(`INSERT INTO companies(id,name,normalized_name,domain,address,url) VALUES($1,$2,$3,$4,$5,$6)`, c.ID, c.Name, domain.NormalizeName(c.Name), c.Domain, c.Address, c.URL); err != nil {
		return c, err
	}
	return t.Company(c.ID, v)
}
func (t *Tx) PatchCompany(id string, input domain.CompanyInput, v Viewer) (domain.Company, error) {
	c, err := t.Company(id, v)
	if err != nil {
		return c, err
	}
	if err = applyCompany(&c, input); err != nil {
		return c, err
	}
	if err = t.Exec(`UPDATE companies SET name=$2,normalized_name=$3,domain=$4,address=$5,url=$6,updated_at=now() WHERE id=$1`, c.ID, c.Name, domain.NormalizeName(c.Name), c.Domain, c.Address, c.URL); err != nil {
		return c, err
	}
	// Only the search projection changes; company foreign keys remain immutable on merge.
	if err = t.refreshCompanySearch(); err != nil {
		return c, err
	}
	return t.Company(c.ID, v)
}
func (t *Tx) refreshCompanySearch() error {
	return t.Exec(`UPDATE contacts SET company_search=co.name FROM companies co WHERE co.id=contacts_company_root(contacts.company_id) AND contacts.company_search IS DISTINCT FROM co.name`)
}
func (t *Tx) MergeCompanies(target, source string, v Viewer) (domain.Company, error) {
	if !v.Admin {
		return domain.Company{}, httpx.Forbidden()
	}
	a, err := t.Company(target, v)
	if err != nil {
		return a, err
	}
	b, err := t.Company(source, v)
	if err != nil {
		return a, err
	}
	if a.ID == b.ID {
		return a, httpx.Invalid("Cannot merge a company into itself")
	}
	if err = t.Exec(`UPDATE companies SET merged_into_id=$1,updated_at=now() WHERE id=$2`, a.ID, b.ID); err != nil {
		return a, err
	}
	if err = t.refreshCompanySearch(); err != nil {
		return a, err
	}
	return t.Company(a.ID, v)
}
func scanTag(row scanner) (tag domain.Tag, err error) {
	err = row.Scan(&tag.ID, &tag.Name, &tag.OwnerMemberID)
	return
}
func (t *Tx) Tag(id string, v Viewer) (domain.Tag, error) {
	return scanTag(t.SQL.QueryRowContext(t.Context, `SELECT id,name,owner_member_id FROM tags WHERE id=$1 AND (owner_member_id IS NULL OR owner_member_id=$2 OR $3)`, id, v.ID, v.Admin))
}
func (t *Tx) Tags(v Viewer) ([]domain.Tag, error) {
	out := []domain.Tag{}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT id,name,owner_member_id FROM tags WHERE owner_member_id IS NULL OR owner_member_id=$1 OR $2 ORDER BY name,id`, v.ID, v.Admin)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		tag, err := scanTag(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tag)
	}
	return out, rows.Err()
}
func (t *Tx) CreateTag(name string, shared bool, v Viewer) (domain.Tag, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return domain.Tag{}, httpx.Invalid("Tag name is required")
	}
	var owner *string
	if shared {
		if !v.Admin {
			return domain.Tag{}, httpx.Forbidden()
		}
	} else {
		owner = &v.ID
	}
	return scanTag(t.SQL.QueryRowContext(t.Context, `INSERT INTO tags(id,name,owner_member_id) VALUES($1,$2,$3) RETURNING id,name,owner_member_id`, ulid.Make().String(), name, owner))
}
func (t *Tx) ContactTag(id, tagID string, on bool, version int, v Viewer) error {
	c, err := t.contact(id, v)
	if err != nil {
		return err
	}
	if err = CheckVersion(c, version); err != nil {
		return err
	}
	if _, err = t.Tag(tagID, v); err != nil {
		return err
	}
	if on {
		err = t.Exec(`INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, id, tagID)
	} else {
		err = t.Exec(`DELETE FROM contact_tags WHERE contact_id=$1 AND tag_id=$2`, id, tagID)
	}
	if err != nil {
		return err
	}
	after, err := t.contact(id, v)
	if err != nil {
		return err
	}
	return t.recordChange(id, v.ID, domain.Diff{"tags": {From: c.Tags, To: after.Tags}}, true)
}
func (t *Tx) DeleteTag(id string, v Viewer) error {
	tag, err := t.Tag(id, v)
	if err != nil {
		return err
	}
	if !v.Admin && (tag.OwnerMemberID == nil || *tag.OwnerMemberID != v.ID) {
		return httpx.Forbidden()
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT contact_id FROM contact_tags WHERE tag_id=$1 ORDER BY contact_id`, id)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err = t.Exec(`DELETE FROM tags WHERE id=$1`, id); err != nil {
		return err
	}
	// Deleting a tag implicitly changes all linked contacts under the same
	// transaction lock, like card deletion. No invisible contact is returned.
	for _, contact := range ids {
		if err = t.recordChange(contact, v.ID, domain.Diff{"removedTag": {From: tag.TagRef, To: nil}}, true); err != nil {
			return err
		}
	}
	return nil
}
