package registration

import (
	"testing"

	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestRegistrarPersistsPolicyAndUsesConfirm(t *testing.T) {
	for _, tc := range []struct {
		name          string
		mode          Mode
		overall       float64
		link, private bool
		want          DecisionKind
	}{
		{"create", ModeAuto, .99, false, false, AutoCreated},
		{"private create", ModeAuto, .99, false, true, AutoCreated},
		{"link", ModeAuto, .1, true, false, AutoLinked},
		{"review", ModeReview, .99, false, false, NeedsReview},
		{"off", ModeOff, .99, false, false, Unavailable},
		{"confidence", ModeAuto, .1, false, false, NeedsReview},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, _ := testutil.Database(t, store.Open)
			v := store.Viewer{ID: "owner"}
			var card domain.BusinessCard
			var existing domain.Contact
			fields := ocr.Fields{FullName: " Name ", Company: " Company ", Emails: []string{" a@example.test ", ""}, Phones: []string{" 123 ", " "}}
			require.NoError(t, db.Do(t.Context(), true, func(tx *store.Tx) error {
				_, err := tx.UpsertMember(v.ID, "Owner", "")
				require.NoError(t, err)
				s := Defaults()
				s.Mode, s.PrivateDefault = tc.mode, tc.private
				require.NoError(t, tx.PutSettings(s, store.Viewer{ID: v.ID, Admin: true}))
				if tc.link {
					existing, err = tx.CreateContact(domain.ContactInput{FullName: &fields.FullName, Emails: &fields.Emails}, v)
					require.NoError(t, err)
				}
				card, err = tx.CreateCard([]byte("image"), "image/jpeg", nil, nil, nil, nil, v)
				return err
			}))
			x, err := db.RecordExtraction(t.Context(), card.ID, ocr.Extraction{Engine: ocr.EngineGatewayVision, Fields: fields, Overall: tc.overall})
			require.NoError(t, err)
			registrar := NewRegistrar(db)
			require.NoError(t, registrar.Register(t.Context(), card.ID, x, v.ID))
			// A duplicate delivery neither creates another contact nor another change.
			require.NoError(t, registrar.Register(t.Context(), card.ID, x, v.ID))
			require.NoError(t, db.Do(t.Context(), false, func(tx *store.Tx) error {
				got, err := tx.Card(card.ID, v)
				require.NoError(t, err)
				require.Equal(t, string(tc.want), *got.Decision)
				require.Equal(t, x, *got.Extraction)
				if tc.want != AutoCreated && tc.want != AutoLinked {
					require.Nil(t, got.ContactID)
					return nil
				}
				c, err := tx.Contact(*got.ContactID, v)
				require.NoError(t, err)
				require.Len(t, c.Cards, 1)
				require.Len(t, c.Encounters, 1)
				require.Equal(t, 1, c.Encounters[0].CardCount)
				require.Equal(t, v.ID, c.Encounters[0].Member.ID)
				require.Equal(t, []string{"a@example.test"}, c.Emails)
				if tc.link {
					require.Equal(t, existing.ID, c.ID)
					require.Equal(t, "member", c.RegisteredBy)
					require.Len(t, c.Changes, 2)
					require.Equal(t, "auto", c.Changes[0].Source)
				} else {
					require.Equal(t, "auto", c.RegisteredBy)
					require.Len(t, c.Changes, 1)
					require.Equal(t, "auto", c.Changes[0].Source)
					require.Equal(t, []string{"123"}, c.Phones)
					require.Equal(t, "Company", c.Company.Name)
					if tc.private {
						require.Equal(t, "private", c.Visibility)
					}
				}
				return nil
			}))
		})
	}
}

func TestRegistrarIgnoresStaleExtractionAndUnlink(t *testing.T) {
	db, _ := testutil.Database(t, store.Open)
	v := store.Viewer{ID: "owner"}
	var card domain.BusinessCard
	require.NoError(t, db.Do(t.Context(), true, func(tx *store.Tx) error {
		_, err := tx.UpsertMember(v.ID, "Owner", "")
		require.NoError(t, err)
		card, err = tx.CreateCard([]byte("image"), "image/jpeg", nil, nil, nil, nil, v)
		return err
	}))
	x, err := db.RecordExtraction(t.Context(), card.ID, ocr.Extraction{Engine: ocr.EngineGatewayVision, Fields: ocr.Fields{FullName: "Name"}, Overall: 1})
	require.NoError(t, err)
	registrar := NewRegistrar(db)
	stale := x
	stale.ID = "stale"
	require.NoError(t, registrar.Register(t.Context(), card.ID, stale, v.ID))
	require.NoError(t, db.Do(t.Context(), false, func(tx *store.Tx) error {
		got, err := tx.Card(card.ID, v)
		require.NoError(t, err)
		require.Nil(t, got.ContactID)
		require.Nil(t, got.Decision)
		return nil
	}))
	require.Error(t, registrar.Register(t.Context(), card.ID, x, "someone-else"))
	require.NoError(t, registrar.Register(t.Context(), card.ID, x, v.ID))
	require.NoError(t, db.Do(t.Context(), true, func(tx *store.Tx) error {
		_, err := tx.UnlinkCard(card.ID, v)
		return err
	}))
	require.NoError(t, registrar.Register(t.Context(), card.ID, x, v.ID))
	require.NoError(t, db.Do(t.Context(), false, func(tx *store.Tx) error {
		got, err := tx.Card(card.ID, v)
		require.NoError(t, err)
		require.Nil(t, got.ContactID)
		require.Equal(t, "unlinked", *got.DecisionReason)
		return nil
	}))
}
