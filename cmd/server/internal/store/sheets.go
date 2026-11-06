package store

import (
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

type SheetRef struct {
	ID   string
	BBox [4]int
}

func (t *Tx) CreateSheet(image []byte, contentType string, detected int, v Viewer) (s domain.Sheet, err error) {
	s = domain.Sheet{ID: ulid.Make().String(), ContentType: contentType, Detected: detected, Image: image}
	// Return metadata without fetching a second copy of the uploaded image.
	err = t.SQL.QueryRowContext(t.Context, `WITH inserted AS (INSERT INTO sheets(id,owner_member_id,image,image_content_type,detected) VALUES($1,$2,$3,$4,$5) RETURNING owner_member_id,created_at) SELECT m.sub,m.display_name,m.email,m.directory_person_id,s.created_at FROM inserted s JOIN members m ON m.sub=s.owner_member_id`, s.ID, v.ID, image, contentType, detected).Scan(&s.Owner.ID, &s.Owner.DisplayName, &s.Owner.Email, &s.Owner.DirectoryPersonID, &s.CreatedAt)
	s.CreatedAt = s.CreatedAt.UTC()
	return
}

func (t *Tx) Sheet(id string, v Viewer) (s domain.Sheet, err error) {
	err = t.SQL.QueryRowContext(t.Context, `SELECT s.id,m.sub,m.display_name,m.email,m.directory_person_id,s.image_content_type,s.detected,s.created_at,s.image FROM sheets s JOIN members m ON m.sub=s.owner_member_id WHERE s.id=$3 AND (s.owner_member_id=$1 OR $2)`, v.ID, v.Admin, id).Scan(&s.ID, &s.Owner.ID, &s.Owner.DisplayName, &s.Owner.Email, &s.Owner.DirectoryPersonID, &s.ContentType, &s.Detected, &s.CreatedAt, &s.Image)
	s.CreatedAt = s.CreatedAt.UTC()
	return
}
