package registration

import (
	"context"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/resolve"
	"github.com/appthrust/contacts/cmd/server/internal/store"
)

type Registrar struct{ store *store.Store }

func NewRegistrar(database *store.Store) *Registrar { return &Registrar{store: database} }

func (g *Registrar) Register(ctx context.Context, cardID string, x ocr.Extraction, owner string) error {
	return g.store.Do(ctx, true, func(tx *store.Tx) error {
		var cardOwner string
		var extractionID, contactID, decision *string
		if err := tx.SQL.QueryRowContext(ctx, `SELECT owner_member_id,extraction_id,contact_id,decision FROM cards WHERE id=$1 FOR UPDATE`, cardID).Scan(&cardOwner, &extractionID, &contactID, &decision); err != nil {
			return err
		}
		if cardOwner != owner {
			return httpx.Forbidden()
		}
		// A late worker must not overwrite human confirmation, unlink, or a
		// decision already made for this extraction.
		if extractionID == nil || *extractionID != x.ID || contactID != nil || decision != nil {
			return nil
		}
		s, err := tx.Settings()
		if err != nil {
			return err
		}
		tx.Viewer = store.Viewer{ID: owner}
		r, err := resolve.Resolve(tx, x)
		if err != nil {
			return err
		}
		d := Decide(s, x, r)
		switch d.Kind {
		case AutoLinked:
			_, err = tx.ConfirmCard(cardID, &d.ContactID, nil, nil, tx.Viewer, "auto")
		case AutoCreated:
			f := x.Fields
			visibility := "shared"
			if s.PrivateDefault {
				visibility = "private"
			}
			input := domain.ContactInput{
				FullName: &f.FullName, Kana: &f.Kana, Title: &f.Title,
				Department: &f.Department, Emails: &f.Emails, Phones: &f.Phones,
				Address: &f.Address, Visibility: &visibility, CompanyID: r.CompanyID,
			}
			// ConfirmCard uses the same trimming and empty-value cleanup as
			// manual registration, and honors the resolved company ID first.
			_, err = tx.ConfirmCard(cardID, nil, &input, &r.CompanyName, tx.Viewer, "auto")
		default:
			err = tx.SetDecision(cardID, string(d.Kind), d.Reason)
		}
		return err
	})
}
