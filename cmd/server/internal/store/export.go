package store

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/lib/pq"
)

type ExportRow struct {
	FullName                                  string
	Kana, Company, Department, Title, Address *string
	Emails, Phones                            []string
	Visibility                                string
	FirstMetAt, LastMetAt                     *time.Time
	MetBy                                     string
}

func (t *Tx) Export(project bool, v Viewer) ([]ExportRow, error) {
	if project && !v.Admin {
		return nil, httpx.Forbidden()
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT c.full_name,c.kana,co.name,c.department,c.title,c.emails,c.phones,c.address,c.visibility,
	 (SELECT min(e.first_at) FROM encounters e WHERE e.contact_id=c.id AND ($3 OR e.member_id=$1)),
	 (SELECT max(e.last_at) FROM encounters e WHERE e.contact_id=c.id AND ($3 OR e.member_id=$1)),
	 coalesce((SELECT string_agg(CASE WHEN m.directory_person_id IS NULL THEN 'unknown member' ELSE m.display_name END,'; ' ORDER BY m.sub) FROM encounters e JOIN members m ON m.sub=e.member_id WHERE e.contact_id=c.id AND ($3 OR e.member_id=$1)),'')
	 FROM contacts c LEFT JOIN companies co ON co.id=contacts_company_root(c.company_id)
	 WHERE `+visibleContact+` AND ($3 OR EXISTS(SELECT 1 FROM encounters e WHERE e.contact_id=c.id AND e.member_id=$1)) ORDER BY c.full_name,c.id`, v.ID, v.Admin, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ExportRow{}
	for rows.Next() {
		var r ExportRow
		if err = rows.Scan(&r.FullName, &r.Kana, &r.Company, &r.Department, &r.Title, pq.Array(&r.Emails), pq.Array(&r.Phones), &r.Address, &r.Visibility, &r.FirstMetAt, &r.LastMetAt, &r.MetBy); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *Store) SeedDev(ctx context.Context) error {
	return s.Do(ctx, true, func(t *Tx) error {
		var count int
		if err := t.SQL.QueryRowContext(ctx, `SELECT count(*) FROM contacts`).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return nil
		}
		img := image.NewRGBA(image.Rect(0, 0, 320, 180))
		for y := range 180 {
			for x := range 320 {
				img.SetRGBA(x, y, color.RGBA{R: 240, G: 246, B: 252, A: 255})
			}
		}
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, img, &jpeg.Options{Quality: 85}); err != nil {
			return err
		}
		for i, name := range []string{"Aoi Tanaka", "Ren Suzuki", "Hana Sato"} {
			v := Viewer{ID: fmt.Sprintf("contacts-demo-%d", i)}
			if _, err := t.UpsertMember(v.ID, name, fmt.Sprintf("member%d@example.test", i)); err != nil {
				return err
			}
			company := "Example Studio"
			emails := []string{fmt.Sprintf("contact%d@example.test", i)}
			c, err := t.CreateContact(domain.ContactInput{FullName: &name, CompanyName: &company, Emails: &emails}, v)
			if err != nil {
				return err
			}
			if _, err = t.CreateCard(encoded.Bytes(), "image/jpeg", &c.ID, nil, nil, nil, v); err != nil {
				return err
			}
		}
		return nil
	})
}
