package store

import (
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/stretchr/testify/require"
)

func TestConfirmCardSourceParityAndHumanDecision(t *testing.T) {
	db := database(t)
	v := Viewer{ID: "owner"}
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		_, err := tx.UpsertMember(v.ID, "Owner", "")
		require.NoError(t, err)
		name, company := " Name ", " Company "
		emails, phones := []string{" a@example.test ", " "}, []string{" 123 ", ""}
		input := domain.ContactInput{FullName: &name, CompanyName: &company, Emails: &emails, Phones: &phones}
		met := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
		contacts := map[string]domain.Contact{}
		for _, source := range []string{"member", "auto"} {
			card, err := tx.CreateCard([]byte("image"), "image/jpeg", nil, &met, nil, nil, v)
			require.NoError(t, err)
			require.NoError(t, tx.SetDecision(card.ID, "NeedsReview", "policy"))
			c, err := tx.ConfirmCard(card.ID, nil, &input, nil, v, source)
			require.NoError(t, err)
			require.Equal(t, source, c.RegisteredBy)
			require.Len(t, c.Changes, 1)
			require.Equal(t, source, c.Changes[0].Source)
			require.Equal(t, v.ID, c.Changes[0].Actor.ID)
			require.Len(t, c.Cards, 1)
			require.Len(t, c.Encounters, 1)
			require.Equal(t, 1, c.Version)
			require.Equal(t, []string{"a@example.test"}, c.Emails)
			require.Equal(t, []string{"123"}, c.Phones)
			if source == "auto" {
				require.Equal(t, "AutoCreated", *c.Cards[0].Decision)
			} else {
				require.Nil(t, c.Cards[0].Decision)
			}
			require.Nil(t, c.Cards[0].DecisionReason)
			contacts[source] = c
		}
		require.Equal(t, contacts["member"].Changes[0].Diff, contacts["auto"].Changes[0].Diff)
		require.Equal(t, contacts["member"].Encounters, contacts["auto"].Encounters)
		auto := contacts["auto"]
		card, err := tx.CreateCard([]byte("image"), "image/jpeg", nil, &met, nil, nil, v)
		require.NoError(t, err)
		auto, err = tx.ConfirmCard(card.ID, &auto.ID, nil, nil, v, "auto")
		require.NoError(t, err)
		require.Equal(t, "AutoLinked", *auto.Cards[0].Decision)
		require.Len(t, auto.Changes, 2)
		for _, change := range auto.Changes {
			require.Equal(t, "auto", change.Source)
		}
		auto, err = tx.ConfirmCard(card.ID, &auto.ID, nil, nil, v, "member")
		require.NoError(t, err)
		require.Nil(t, auto.Cards[0].Decision)
		// Source is scoped to confirmation, not leaked to later manual writes.
		manual, err := tx.CreateContact(domain.ContactInput{FullName: &name}, v)
		require.NoError(t, err)
		require.Equal(t, "member", manual.RegisteredBy)
		require.Equal(t, "member", manual.Changes[0].Source)
		return nil
	}))
}

func TestUnlinkAutoContact(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		memberEdit, extraCard bool
		unlinkExtraFirst      bool
		wantState             string
	}{
		{"untouched", false, false, false, "archived"},
		{"member edited", true, false, false, "active"},
		{"another card", false, true, false, "active"},
		// Detaching the other card first writes a member-sourced removedCard
		// change; that is not a human edit, so the last unlink still archives.
		{"last card after detaching the other", false, true, true, "archived"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := database(t)
			v := Viewer{ID: "owner"}
			require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
				_, err := tx.UpsertMember(v.ID, "Owner", "")
				require.NoError(t, err)
				_, err = tx.UpsertMember("other", "Other", "")
				require.NoError(t, err)
				card, err := tx.CreateCard([]byte("image"), "image/jpeg", nil, nil, nil, nil, v)
				require.NoError(t, err)
				name := "Name"
				c, err := tx.ConfirmCard(card.ID, nil, &domain.ContactInput{FullName: &name}, nil, v, "auto")
				require.NoError(t, err)
				if tc.memberEdit {
					note := "Human edit"
					c, err = tx.PatchContact(c.ID, domain.ContactInput{Notes: &note}, c.Version, v)
					require.NoError(t, err)
				}
				var extraID string
				if tc.extraCard {
					other, err := tx.CreateCard([]byte("image"), "image/jpeg", nil, nil, nil, nil, v)
					require.NoError(t, err)
					_, err = tx.ConfirmCard(other.ID, &c.ID, nil, nil, v, "auto")
					require.NoError(t, err)
					extraID = other.ID
				}
				if tc.unlinkExtraFirst {
					_, err = tx.UnlinkCard(extraID, v)
					require.NoError(t, err)
				}
				_, err = tx.UnlinkCard(card.ID, Viewer{ID: "other"})
				var forbidden *httpx.Error
				require.ErrorAs(t, err, &forbidden)
				require.Equal(t, 403, forbidden.Status)
				unlinked, err := tx.UnlinkCard(card.ID, v)
				require.NoError(t, err)
				require.Nil(t, unlinked.ContactID)
				require.Equal(t, "NeedsReview", *unlinked.Decision)
				require.Equal(t, "unlinked", *unlinked.DecisionReason)
				c, err = tx.Contact(c.ID, v)
				require.NoError(t, err)
				require.Equal(t, tc.wantState, c.State)
				if tc.extraCard && !tc.unlinkExtraFirst {
					require.Len(t, c.Encounters, 1)
					require.Equal(t, 1, c.Encounters[0].CardCount)
				} else {
					require.Empty(t, c.Encounters)
				}
				return nil
			}))
		})
	}
}

func TestSettingsDefaultsAndRoundTrip(t *testing.T) {
	db := database(t)
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		defaults, err := tx.Settings()
		require.NoError(t, err)
		require.Equal(t, domain.DefaultRegistrationSettings(), defaults)
		v := Viewer{ID: "admin", Admin: true}
		_, err = tx.UpsertMember(v.ID, "Admin", "")
		require.NoError(t, err)
		changed := defaults
		changed.Mode, changed.AutoCreateThreshold, changed.AutoLinkThreshold = "review", .75, .95
		changed.RequiredFields, changed.ExtractorPreference = []string{"fullName", "emails"}, []string{"local", "gateway-vision"}
		changed.PrivateDefault = true
		require.Error(t, tx.PutSettings(changed, Viewer{ID: v.ID}))
		require.NoError(t, tx.PutSettings(changed, v))
		got, err := tx.Settings()
		require.NoError(t, err)
		require.Equal(t, changed, got)
		require.NoError(t, tx.PutSettings(defaults, v))
		got, err = tx.Settings()
		require.NoError(t, err)
		require.Equal(t, defaults, got)
		var count int
		var actor string
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*),min(updated_by) FROM settings`).Scan(&count, &actor))
		require.Equal(t, 1, count)
		require.Equal(t, v.ID, actor)
		return nil
	}))
}

func TestUnavailableRetryAndAppendOnlyExtractions(t *testing.T) {
	db := database(t)
	v := Viewer{ID: "owner"}
	var card domain.BusinessCard
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		_, err := tx.UpsertMember(v.ID, "Owner", "")
		require.NoError(t, err)
		card, err = tx.CreateCard([]byte("image"), "image/jpeg", nil, nil, nil, nil, v)
		return err
	}))
	require.NoError(t, db.MarkUnavailable(t.Context(), card.ID))
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		unavailable, err := tx.Card(card.ID, v)
		require.NoError(t, err)
		require.Equal(t, "Unavailable", *unavailable.Decision)
		retried, err := tx.RetryOCR(card.ID, v)
		require.NoError(t, err)
		require.Equal(t, "pending", retried.OCRState)
		require.Nil(t, retried.Decision)
		require.Nil(t, retried.DecisionReason)
		return nil
	}))
	x, err := db.RecordExtraction(t.Context(), card.ID, ocr.Extraction{Engine: "gateway-vision", Fields: ocr.Fields{FullName: "First"}})
	require.NoError(t, err)
	// A later extraction is append-only even when replacing the card pointer.
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		return tx.Exec(`UPDATE cards SET ocr_state='failed',decision='NeedsReview',decision_reason='policy' WHERE id=$1`, card.ID)
	}))
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error { _, err := tx.RetryOCR(card.ID, v); return err }))
	y, err := db.RecordExtraction(t.Context(), card.ID, ocr.Extraction{Engine: "gateway-vision", Fields: ocr.Fields{FullName: "Second"}})
	require.NoError(t, err)
	require.NotEqual(t, x.ID, y.ID)
	require.NoError(t, db.Do(t.Context(), false, func(tx *Tx) error {
		got, err := tx.Card(card.ID, v)
		require.NoError(t, err)
		require.Equal(t, y, *got.Extraction)
		var first string
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT fields->>'fullName' FROM extractions WHERE id=$1`, x.ID).Scan(&first))
		require.Equal(t, "First", first)
		return nil
	}))
}

func TestResolutionReadsRespectVisibilityAndCompanyRedirects(t *testing.T) {
	db := database(t)
	owner := Viewer{ID: "owner"}
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		for _, id := range []string{"owner", "other"} {
			_, err := tx.UpsertMember(id, id, "")
			require.NoError(t, err)
		}
		companyName, companyDomain := "ＡＣＭＥ", " Acme.Test "
		company, err := tx.CreateCompany(domain.CompanyInput{Name: &companyName, Domain: &companyDomain}, owner)
		require.NoError(t, err)
		rootName := "Root"
		root, err := tx.CreateCompany(domain.CompanyInput{Name: &rootName}, owner)
		require.NoError(t, err)
		_, err = tx.MergeCompanies(root.ID, company.ID, Viewer{ID: owner.ID, Admin: true})
		require.NoError(t, err)
		name, private := "Ａｏｉ　Tanaka", "private"
		emails := []string{" Aoi@Example.Test "}
		c, err := tx.CreateContact(domain.ContactInput{FullName: &name, Emails: &emails, CompanyID: &company.ID, Visibility: &private}, owner)
		require.NoError(t, err)
		tx.Viewer = Viewer{ID: "other"}
		hidden, err := tx.ContactsByEmail([]string{"aoi@example.test"})
		require.NoError(t, err)
		require.Empty(t, hidden)
		hidden, err = tx.ContactsByNormalizedName("aoi tanaka")
		require.NoError(t, err)
		require.Empty(t, hidden)
		tx.Viewer = owner
		found, err := tx.ContactsByEmail([]string{" AOI@example.test "})
		require.NoError(t, err)
		require.Len(t, found, 1)
		require.Equal(t, c.ID, found[0].ID)
		require.Equal(t, root.ID, found[0].Company.ID)
		found, err = tx.ContactsByNormalizedName("aoi tanaka")
		require.NoError(t, err)
		require.Len(t, found, 1)
		byName, err := tx.CompanyByNormalizedName("acme")
		require.NoError(t, err)
		require.Equal(t, root.ID, byName.ID)
		byDomain, err := tx.CompanyByDomain(" ACME.TEST ")
		require.NoError(t, err)
		require.Equal(t, root.ID, byDomain.ID)
		missing, err := tx.CompanyByDomain("missing.test")
		require.NoError(t, err)
		require.Nil(t, missing)
		require.NoError(t, tx.ArchiveContact(c.ID, c.Version, owner))
		found, err = tx.ContactsByNormalizedName(name)
		require.NoError(t, err)
		require.Empty(t, found)
		return nil
	}))
}

func TestSheetCardsVisibilityAndLastDelete(t *testing.T) {
	db := database(t)
	owner := Viewer{ID: "owner"}
	other := Viewer{ID: "other"}
	admin := Viewer{ID: "admin", Admin: true}
	var sheet domain.Sheet
	var cards []domain.BusinessCard
	require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
		for _, viewer := range []Viewer{owner, other, admin} {
			_, err := tx.UpsertMember(viewer.ID, viewer.ID, viewer.ID+"@example.test")
			require.NoError(t, err)
		}
		var err error
		sheet, err = tx.CreateSheet([]byte("original"), "image/jpeg", 3, owner)
		require.NoError(t, err)
		require.Equal(t, owner.ID, sheet.Owner.ID)
		require.Equal(t, "image/jpeg", sheet.ContentType)
		require.Equal(t, 3, sheet.Detected)
		require.Equal(t, []byte("original"), sheet.Image)
		require.False(t, sheet.CreatedAt.IsZero())
		require.Equal(t, time.UTC, sheet.CreatedAt.Location())
		for i := range 3 {
			ref := SheetRef{ID: sheet.ID, BBox: [4]int{i * 300, 0, i*300 + 250, 200}}
			card, err := tx.CreateCard([]byte("crop"), "image/jpeg", nil, nil, nil, &ref, owner)
			require.NoError(t, err)
			require.Equal(t, &sheet.ID, card.SheetID)
			require.Equal(t, &ref.BBox, card.BBox)
			require.Equal(t, "pending", card.OCRState)
			cards = append(cards, card)
		}
		single, err := tx.CreateCard([]byte("single"), "image/jpeg", nil, nil, nil, nil, owner)
		require.NoError(t, err)
		require.Nil(t, single.SheetID)
		require.Nil(t, single.BBox)
		return nil
	}))
	for _, viewer := range []Viewer{owner, admin} {
		require.NoError(t, db.Do(t.Context(), false, func(tx *Tx) error {
			got, err := tx.Sheet(sheet.ID, viewer)
			require.NoError(t, err)
			require.Equal(t, sheet, got)
			return nil
		}))
	}
	err := db.Do(t.Context(), false, func(tx *Tx) error {
		_, err := tx.Sheet(sheet.ID, other)
		return err
	})
	var hidden *httpx.Error
	require.ErrorAs(t, err, &hidden)
	require.Equal(t, 404, hidden.Status)
	require.NoError(t, db.Do(t.Context(), false, func(tx *Tx) error {
		page, err := tx.Cards(false, "", 20, owner)
		require.NoError(t, err)
		require.Len(t, page.Items, 4)
		sheetCards := 0
		for _, card := range page.Items {
			if card.SheetID != nil {
				require.Equal(t, sheet.ID, *card.SheetID)
				require.NotNil(t, card.BBox)
				sheetCards++
			}
		}
		require.Equal(t, 3, sheetCards)
		return nil
	}))
	for i, card := range cards {
		require.NoError(t, db.Do(t.Context(), true, func(tx *Tx) error {
			return tx.DeleteCard(card.ID, owner)
		}))
		err := db.Do(t.Context(), false, func(tx *Tx) error {
			_, err := tx.Sheet(sheet.ID, owner)
			return err
		})
		if i < len(cards)-1 {
			require.NoError(t, err)
		} else {
			require.ErrorAs(t, err, &hidden)
			require.Equal(t, 404, hidden.Status)
		}
	}
}
