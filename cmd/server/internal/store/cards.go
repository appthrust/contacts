package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/lib/pq"
	"github.com/oklog/ulid/v2"
)

var _ ocr.Store = (*Store)(nil)

const cardSelect = `SELECT b.id,b.contact_id,m.sub,m.display_name,m.email,m.directory_person_id,b.ocr_state,
 CASE WHEN x.id IS NULL THEN NULL ELSE jsonb_build_object('id',x.id,'engine',x.engine,'model',x.model,'fields',x.fields,'fieldConfidence',x.field_confidence,'overall',x.overall,'durationMs',x.duration_ms,'createdAt',x.created_at) END,
 b.decision,b.decision_reason,b.ocr_error,b.exchanged_at,b.place,b.created_at,b.sheet_id,to_json(b.bbox) FROM cards b JOIN members m ON m.sub=b.owner_member_id LEFT JOIN extractions x ON x.id=b.extraction_id `
const visibleCard = `((b.contact_id IS NULL AND (b.owner_member_id=$1 OR $2)) OR EXISTS(SELECT 1 FROM contacts c WHERE c.id=b.contact_id AND ` + visibleContact + `))`

func scanCard(row scanner) (b domain.BusinessCard, err error) {
	var raw, bbox []byte
	err = row.Scan(&b.ID, &b.ContactID, &b.Owner.ID, &b.Owner.DisplayName, &b.Owner.Email, &b.Owner.DirectoryPersonID, &b.OCRState, &raw, &b.Decision, &b.DecisionReason, &b.OCRError, &b.ExchangedAt, &b.Place, &b.CreatedAt, &b.SheetID, &bbox)
	if err != nil {
		return
	}
	if len(bbox) > 0 {
		if err = json.Unmarshal(bbox, &b.BBox); err != nil {
			return
		}
	}
	b.CreatedAt = b.CreatedAt.UTC()
	if b.ExchangedAt != nil {
		at := b.ExchangedAt.UTC()
		b.ExchangedAt = &at
	}
	b.ImageURL = "/api/contacts/v1/cards/" + b.ID + "/image"
	if len(raw) > 0 {
		err = json.Unmarshal(raw, &b.Extraction)
		if err == nil && b.Extraction != nil {
			b.Extraction.CreatedAt = b.Extraction.CreatedAt.UTC()
		}
	}
	return
}
func (t *Tx) Card(id string, v Viewer) (domain.BusinessCard, error) {
	return scanCard(t.SQL.QueryRowContext(t.Context, cardSelect+`WHERE b.id=$3 AND `+visibleCard, v.ID, v.Admin, id))
}
func (t *Tx) CardImage(id string, v Viewer) ([]byte, string, error) {
	var image []byte
	var contentType string
	err := t.SQL.QueryRowContext(t.Context, `SELECT b.image,b.image_content_type FROM cards b WHERE b.id=$3 AND `+visibleCard, v.ID, v.Admin, id).Scan(&image, &contentType)
	return image, contentType, err
}
func (t *Tx) contactCards(id string, v Viewer) ([]domain.BusinessCard, error) {
	rows, err := t.SQL.QueryContext(t.Context, cardSelect+`WHERE b.contact_id=$3 AND `+visibleCard+` ORDER BY b.created_at DESC,b.id DESC`, v.ID, v.Admin, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.BusinessCard{}
	for rows.Next() {
		b, err := scanCard(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
func (t *Tx) Cards(all bool, cursor string, limit int, v Viewer) (Page[domain.BusinessCard], error) {
	page := Page[domain.BusinessCard]{Items: []domain.BusinessCard{}}
	if all && !v.Admin {
		return page, httpx.Forbidden()
	}
	at, id, err := cursorArgs(cursor)
	if err != nil {
		return page, err
	}
	rows, err := t.SQL.QueryContext(t.Context, cardSelect+`WHERE `+visibleCard+` AND ($3 OR b.owner_member_id=$1) AND ($4::timestamptz IS NULL OR (b.created_at,b.id)<($4::timestamptz,$5)) ORDER BY b.created_at DESC,b.id DESC LIMIT $6`, v.ID, v.Admin, all, at, id, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		b, err := scanCard(rows)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, b)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		b := page.Items[limit-1]
		page.NextCursor = nextCursor(b.CreatedAt, b.ID)
	}
	return page, nil
}
func (t *Tx) recomputeEncounters(id string) error {
	if err := t.Exec(`DELETE FROM encounters WHERE contact_id=$1`, id); err != nil {
		return err
	}
	return t.Exec(`INSERT INTO encounters(contact_id,member_id,first_at,last_at,card_count) SELECT contact_id,owner_member_id,min(coalesce(exchanged_at,created_at)),max(coalesce(exchanged_at,created_at)),count(*) FROM cards WHERE contact_id=$1 GROUP BY contact_id,owner_member_id`, id)
}
func (t *Tx) CreateCard(image []byte, contentType string, contactID *string, exchangedAt *time.Time, place *string, sheet *SheetRef, v Viewer) (domain.BusinessCard, error) {
	id := ulid.Make().String()
	state := "pending"
	if contactID != nil {
		c, err := t.contact(*contactID, v)
		if err != nil {
			return domain.BusinessCard{}, err
		}
		if c.State == "archived" {
			return domain.BusinessCard{}, httpx.Conflict("Archived contacts cannot receive cards")
		}
		state = "unavailable"
	}
	var sheetID *string
	var bbox any
	if sheet != nil {
		sheetID = &sheet.ID
		bbox = pq.Array(sheet.BBox[:])
	}
	if err := t.Exec(`INSERT INTO cards(id,contact_id,owner_member_id,image,image_content_type,ocr_state,exchanged_at,place,sheet_id,bbox) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, contactID, v.ID, image, contentType, state, exchangedAt, place, sheetID, bbox); err != nil {
		return domain.BusinessCard{}, err
	}
	if contactID != nil {
		if err := t.recomputeEncounters(*contactID); err != nil {
			return domain.BusinessCard{}, err
		}
		if err := t.recordChange(*contactID, v.ID, domain.Diff{"addedCard": {From: nil, To: id}}, true); err != nil {
			return domain.BusinessCard{}, err
		}
	}
	return t.Card(id, v)
}
func (t *Tx) ConfirmCard(id string, contactID *string, input *domain.ContactInput, companyName *string, v Viewer, source string) (domain.Contact, error) {
	if source != "member" && source != "auto" {
		return domain.Contact{}, httpx.Invalid("Source must be member or auto")
	}
	previousSource := t.source
	t.source = source
	defer func() { t.source = previousSource }()
	b, err := scanCard(t.SQL.QueryRowContext(t.Context, cardSelect+`WHERE b.id=$3 AND `+visibleCard+` FOR UPDATE OF b`, v.ID, v.Admin, id))
	if err != nil {
		return domain.Contact{}, err
	}
	if b.Owner.ID != v.ID && !v.Admin {
		return domain.Contact{}, httpx.Forbidden()
	}
	var c domain.Contact
	if contactID != nil {
		c, err = t.contact(*contactID, v)
	} else if input != nil {
		if input.CompanyName == nil {
			input.CompanyName = companyName
		}
		c, err = t.CreateContact(*input, v)
	} else {
		return c, httpx.Invalid("Provide contactId or contact")
	}
	if err != nil {
		return c, err
	}
	if c.State == "archived" {
		return c, httpx.Conflict("Archived contacts cannot receive cards")
	}
	var decision *string
	if source == "auto" {
		kind := "AutoCreated"
		if contactID != nil {
			kind = "AutoLinked"
		}
		decision = &kind
	}
	if err = t.Exec(`UPDATE cards SET contact_id=$2,decision=$3,decision_reason=NULL WHERE id=$1`, id, c.ID, decision); err != nil {
		return c, err
	}
	if b.ContactID != nil && *b.ContactID == c.ID {
		return t.Contact(c.ID, v)
	}
	if b.ContactID != nil {
		if err = t.recomputeEncounters(*b.ContactID); err != nil {
			return c, err
		}
		if err = t.recordChange(*b.ContactID, v.ID, domain.Diff{"removedCard": {From: id, To: nil}}, true); err != nil {
			return c, err
		}
	}
	if err = t.recomputeEncounters(c.ID); err != nil {
		return c, err
	}
	// A newly created contact already has its single creation change and
	// initial version; linking the first card is part of that same creation.
	if contactID != nil {
		if err = t.recordChange(c.ID, v.ID, domain.Diff{"addedCard": {From: nil, To: id}}, true); err != nil {
			return c, err
		}
	}
	return t.Contact(c.ID, v)
}
func (t *Tx) SetDecision(cardID, kind, reason string) error {
	return t.Exec(`UPDATE cards SET decision=$2,decision_reason=$3 WHERE id=$1`, cardID, kind, domain.Nullable(reason))
}

func (t *Tx) UnlinkCard(id string, v Viewer) (domain.BusinessCard, error) {
	b, err := scanCard(t.SQL.QueryRowContext(t.Context, cardSelect+`WHERE b.id=$3 AND `+visibleCard+` FOR UPDATE OF b`, v.ID, v.Admin, id))
	if err != nil {
		return b, err
	}
	if b.Owner.ID != v.ID && !v.Admin {
		return b, httpx.Forbidden()
	}
	if err = t.Exec(`UPDATE cards SET contact_id=NULL,decision='NeedsReview',decision_reason='unlinked' WHERE id=$1`, id); err != nil {
		return b, err
	}
	if b.ContactID != nil {
		if err = t.recomputeEncounters(*b.ContactID); err != nil {
			return b, err
		}
		c, err := t.contact(*b.ContactID, Viewer{ID: v.ID, Admin: true})
		if err != nil {
			return b, err
		}
		// A human edit is a profile change. Card attach/detach rows (addedCard /
		// removedCard) are written by card operations and do not make an
		// auto-registered contact "touched" (R3).
		var untouched bool
		if err = t.SQL.QueryRowContext(t.Context, `SELECT NOT EXISTS(SELECT 1 FROM cards WHERE contact_id=$1) AND NOT EXISTS(SELECT 1 FROM contact_changes WHERE contact_id=$1 AND source='member' AND (diff - 'addedCard' - 'removedCard') <> '{}'::jsonb)`, c.ID).Scan(&untouched); err != nil {
			return b, err
		}
		diff := domain.Diff{"removedCard": {From: id, To: nil}}
		if c.RegisteredBy == "auto" && untouched && c.State != "archived" {
			if err = t.Exec(`UPDATE contacts SET state='archived' WHERE id=$1`, c.ID); err != nil {
				return b, err
			}
			diff["state"] = domain.ValueChange{From: c.State, To: "archived"}
		}
		if err = t.recordChange(c.ID, v.ID, diff, true); err != nil {
			return b, err
		}
	}
	return t.Card(id, v)
}
func (t *Tx) DeleteCard(id string, v Viewer) error {
	b, err := t.Card(id, v)
	if err != nil {
		return err
	}
	if b.Owner.ID != v.ID && !v.Admin {
		return httpx.Forbidden()
	}
	if err = t.Exec(`DELETE FROM cards WHERE id=$1`, id); err != nil {
		return err
	}
	if b.SheetID != nil {
		// Store.Do serializes mutations; the last card delete observes all
		// previous removals before reclaiming the sheet.
		if err = t.Exec(`DELETE FROM sheets WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM cards WHERE sheet_id=$1)`, *b.SheetID); err != nil {
			return err
		}
	}
	if b.ContactID != nil {
		if err = t.recomputeEncounters(*b.ContactID); err != nil {
			return err
		}
		return t.recordChange(*b.ContactID, v.ID, domain.Diff{"removedCard": {From: id, To: nil}}, true)
	}
	return nil
}
func (t *Tx) RetryOCR(id string, v Viewer) (domain.BusinessCard, error) {
	b, err := t.Card(id, v)
	if err != nil {
		return b, err
	}
	if b.Owner.ID != v.ID && !v.Admin {
		return b, httpx.Forbidden()
	}
	if b.OCRState != "failed" && b.OCRState != "unavailable" {
		return b, httpx.Conflict("Only failed or unavailable OCR can be retried")
	}
	if err = t.Exec(`UPDATE cards SET ocr_state='pending',ocr_error=NULL,claimed_at=NULL,decision=NULL,decision_reason=NULL WHERE id=$1`, id); err != nil {
		return b, err
	}
	return t.Card(id, v)
}
func (s *Store) ClaimPendingCards(ctx context.Context, limit int, lease time.Duration) ([]ocr.Card, error) {
	out := []ocr.Card{}
	if limit < 1 {
		return out, nil
	}
	err := s.Do(ctx, true, func(t *Tx) error {
		rows, err := t.SQL.QueryContext(ctx, `UPDATE cards SET claimed_at=now() WHERE id IN (SELECT id FROM cards WHERE ocr_state='pending' AND (claimed_at IS NULL OR claimed_at<now()-make_interval(secs => $2)) ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id,image,image_content_type,owner_member_id`, limit, lease.Seconds())
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c ocr.Card
			if err = rows.Scan(&c.ID, &c.Image, &c.ContentType, &c.OwnerMemberID); err != nil {
				return err
			}
			out = append(out, c)
		}
		return rows.Err()
	})
	return out, err
}
func (s *Store) RecordExtraction(ctx context.Context, cardID string, x ocr.Extraction) (ocr.Extraction, error) {
	fields, err := json.Marshal(x.Fields)
	if err != nil {
		return x, err
	}
	if x.FieldConfidence == nil {
		x.FieldConfidence = map[string]float64{}
	}
	confidence, err := json.Marshal(x.FieldConfidence)
	if err != nil {
		return x, err
	}
	err = s.Do(ctx, true, func(t *Tx) error {
		var state string
		if err := t.SQL.QueryRowContext(ctx, `SELECT ocr_state FROM cards WHERE id=$1 FOR UPDATE`, cardID).Scan(&state); err != nil {
			return err
		}
		if state != "pending" {
			return httpx.Conflict("Only pending OCR can record an extraction")
		}
		x.ID = ulid.Make().String()
		if err := t.SQL.QueryRowContext(ctx, `INSERT INTO extractions(id,card_id,engine,model,fields,field_confidence,overall,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`, x.ID, cardID, x.Engine, x.Model, fields, confidence, x.Overall, x.DurationMs).Scan(&x.CreatedAt); err != nil {
			return err
		}
		x.CreatedAt = x.CreatedAt.UTC()
		return t.Exec(`UPDATE cards SET extraction_id=$2,ocr_state='done',ocr_error=NULL,claimed_at=NULL,decision=NULL,decision_reason=NULL WHERE id=$1`, cardID, x.ID)
	})
	return x, err
}
func (s *Store) FailCard(ctx context.Context, id, reason string) error {
	return s.Do(ctx, true, func(t *Tx) error {
		return t.Exec(`UPDATE cards SET ocr_state='failed',ocr_error=$2,claimed_at=NULL WHERE id=$1 AND ocr_state='pending'`, id, reason)
	})
}
func (s *Store) MarkUnavailable(ctx context.Context, id string) error {
	return s.Do(ctx, true, func(t *Tx) error {
		return t.Exec(`UPDATE cards SET ocr_state='unavailable',ocr_error=NULL,claimed_at=NULL,decision='Unavailable',decision_reason=NULL WHERE id=$1 AND ocr_state='pending'`, id)
	})
}
