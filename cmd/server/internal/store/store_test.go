package store

import (
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/lib/pq"
	"github.com/oklog/ulid/v2"
	"github.com/stretchr/testify/require"
)

func database(t *testing.T) *Store {
	t.Helper()
	if dsn := os.Getenv("ADDONSERVER_TEST_DATABASE_URL"); dsn != "" {
		t.Setenv("BUILTIN_APPSERVER_TEST_DATABASE_URL", dsn)
	}
	db, _ := testutil.Database(t, Open)
	return db
}
func TestTranslateAndCursor(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
	}{{sql.ErrNoRows, 404}, {&pq.Error{Code: "23505"}, 409}, {&pq.Error{Code: "23503"}, 400}, {&pq.Error{Code: "23514"}, 400}} {
		var result *httpx.Error
		require.True(t, errors.As(translate(tc.err), &result))
		require.Equal(t, tc.status, result.Status)
	}
	at := time.Now().UTC()
	id := ulid.Make().String()
	got, key, err := ParseCursor(*nextCursor(at, id))
	require.NoError(t, err)
	require.True(t, at.Equal(got))
	require.Equal(t, id, key)
	for _, cursor := range []string{"bad", "", "fHw"} {
		_, _, err = ParseCursor(cursor)
		require.Error(t, err)
	}
}
func TestContactsEncountersVisibilityAndMerges(t *testing.T) {
	db := database(t)
	v := Viewer{ID: "owner"}
	other := Viewer{ID: "other"}
	admin := Viewer{ID: "admin", Admin: true}
	var first, second domain.Contact
	var card domain.BusinessCard
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		for _, viewer := range []Viewer{v, other, admin} {
			_, err := tx.UpsertMember(viewer.ID, viewer.ID, viewer.ID+"@example.test")
			require.NoError(t, err)
		}
		name, company, private := "Ａｏｉ Tanaka", "Acme", "private"
		emails := []string{"aoi@example.test"}
		var err error
		first, err = tx.CreateContact(domain.ContactInput{FullName: &name, CompanyName: &company, Emails: &emails, Visibility: &private}, v)
		require.NoError(t, err)
		_, err = tx.Contact(first.ID, other)
		require.Error(t, err)
		card, err = tx.CreateCard([]byte("image"), "image/webp", &first.ID, nil, nil, nil, v)
		require.NoError(t, err)
		first, err = tx.Contact(first.ID, v)
		require.NoError(t, err)
		require.Len(t, first.Encounters, 1)
		require.Equal(t, 1, first.Encounters[0].CardCount)
		require.Equal(t, 2, first.Version)
		_, err = tx.PatchContact(first.ID, domain.ContactInput{}, 1, v)
		var conflict *httpx.Error
		require.ErrorAs(t, err, &conflict)
		require.Equal(t, "version_conflict", conflict.Code)
		name = "Aoi Tanaka"
		second, err = tx.CreateContact(domain.ContactInput{FullName: &name, CompanyName: &company, Emails: &emails}, v)
		require.NoError(t, err)
		duplicates, err := tx.Duplicates(100, v)
		require.NoError(t, err)
		require.Len(t, duplicates, 1)
		require.Equal(t, "name_domain", duplicates[0].Reason)
		hidden, err := tx.Duplicates(100, other)
		require.NoError(t, err)
		require.Empty(t, hidden)
		merged, err := tx.MergeContacts(second.ID, first.ID, second.Version, v)
		require.NoError(t, err)
		require.Len(t, merged.Cards, 1)
		require.Len(t, merged.Encounters, 1)
		archived, err := tx.Contact(first.ID, v)
		require.NoError(t, err)
		require.Equal(t, "archived", archived.State)
		require.Empty(t, archived.Encounters)
		require.NoError(t, tx.DeleteCard(card.ID, v))
		merged, err = tx.Contact(second.ID, v)
		require.NoError(t, err)
		require.Empty(t, merged.Encounters)
		company2 := "Other company"
		co, err := tx.CreateCompany(domain.CompanyInput{Name: &company2}, v)
		require.NoError(t, err)
		oldCompany := *second.CompanyID
		_, err = tx.MergeCompanies(co.ID, oldCompany, admin)
		require.NoError(t, err)
		redirect, err := tx.Company(oldCompany, v)
		require.NoError(t, err)
		require.Equal(t, co.ID, redirect.ID)
		var stored string
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT company_id FROM contacts WHERE id=$1`, second.ID).Scan(&stored))
		require.Equal(t, oldCompany, stored)
		return nil
	}))
}
func TestOCRClaimsReclamationAndImmutableCompletion(t *testing.T) {
	db := database(t)
	var card domain.BusinessCard
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		_, err := tx.UpsertMember("member", "Member", "")
		require.NoError(t, err)
		card, err = tx.CreateCard([]byte("image"), "image/heic", nil, nil, nil, nil, Viewer{ID: "member"})
		return err
	}))
	lease := 5 * time.Minute
	claimed, err := db.ClaimPendingCards(t.Context(), 2, lease)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	require.Equal(t, "member", claimed[0].OwnerMemberID)
	claimed, err = db.ClaimPendingCards(t.Context(), 2, lease)
	require.NoError(t, err)
	require.Empty(t, claimed)
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		return tx.Exec(`UPDATE cards SET claimed_at=now()-interval '6 minutes' WHERE id=$1`, card.ID)
	}))
	claimed, err = db.ClaimPendingCards(t.Context(), 2, 12*time.Minute)
	require.NoError(t, err)
	require.Empty(t, claimed, "a slow read inside its lease must not be reclaimed")
	claimed, err = db.ClaimPendingCards(t.Context(), 2, lease)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	x, err := db.RecordExtraction(t.Context(), card.ID, ocr.Extraction{Engine: ocr.EngineGatewayVision, Fields: ocr.Fields{FullName: "Read", Confidence: .9}, Overall: .9})
	require.NoError(t, err)
	require.NotEmpty(t, x.ID)
	require.False(t, x.CreatedAt.IsZero())
	_, err = db.RecordExtraction(t.Context(), card.ID, ocr.Extraction{Fields: ocr.Fields{FullName: "Overwritten"}})
	require.Error(t, err)
	require.NoError(t, db.Do(t.Context(), false, func(tx *Tx) error {
		c, err := tx.Card(card.ID, Viewer{ID: "member"})
		require.NoError(t, err)
		require.Equal(t, "done", c.OCRState)
		require.Equal(t, "Read", c.Extraction.Fields.FullName)
		require.Equal(t, x, *c.Extraction)
		var count int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM extractions WHERE card_id=$1`, card.ID).Scan(&count))
		require.Equal(t, 1, count)
		return nil
	}))
}
func TestSeedAndStableCursor(t *testing.T) {
	db := database(t)
	require.NoError(t, db.SeedDev(t.Context()))
	require.NoError(t, db.SeedDev(t.Context()))
	require.NoError(t, db.Do(t.Context(), false, func(tx *Tx) error {
		page, err := tx.Contacts(ContactOptions{Limit: 2, Viewer: Viewer{ID: "reader"}})
		require.NoError(t, err)
		require.Len(t, page.Items, 2)
		require.NotNil(t, page.NextCursor)
		next, err := tx.Contacts(ContactOptions{Limit: 2, Cursor: *page.NextCursor, Viewer: Viewer{ID: "reader"}})
		require.NoError(t, err)
		require.Len(t, next.Items, 1)
		require.Nil(t, next.NextCursor)
		for _, c := range page.Items {
			require.NotEqual(t, c.ID, next.Items[0].ID)
		}
		return nil
	}))
}
