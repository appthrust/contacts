package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

type splitterFunc func(context.Context, []byte, string, int, int, string) ([]ocr.Region, error)

func (splitterFunc) Name() string { return ocr.EngineGatewayVision }
func (f splitterFunc) Split(ctx context.Context, image []byte, contentType string, width, height int, authorization string) ([]ocr.Region, error) {
	return f(ctx, image, contentType, width, height, authorization)
}

func sheetRegions() []ocr.Region {
	return []ocr.Region{
		{X1: 50, Y1: 50, X2: 550, Y2: 300},
		{X1: 650, Y1: 50, X2: 1150, Y2: 300},
		{X1: 50, Y1: 500, X2: 550, Y2: 750},
	}
}

func uploadSheetPNG(h *harness, contact string) (*httptest.ResponseRecorder, []byte) {
	h.t.Helper()
	var imageData, body bytes.Buffer
	require.NoError(h.t, png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 1200, 900))))
	writer := multipart.NewWriter(&body)
	part, err := writer.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="image"; filename="sheet.png"`},
		"Content-Type":        {"image/png"},
	})
	require.NoError(h.t, err)
	_, err = part.Write(imageData.Bytes())
	require.NoError(h.t, err)
	require.NoError(h.t, writer.WriteField("exchangedAt", "2026-10-01T12:00:00Z"))
	require.NoError(h.t, writer.WriteField("place", "Conference"))
	if contact != "" {
		require.NoError(h.t, writer.WriteField("contactId", contact))
	}
	require.NoError(h.t, writer.Close())
	return h.request("owner", "POST", "/cards", &body, writer.FormDataContentType(), 0), imageData.Bytes()
}

func TestSheetUploadEnqueuesAfterCommitAndDeletesLastSheet(t *testing.T) {
	h := newHarness(t, fakeExtractor{})
	var enqueued, events []string
	var normalized []byte
	queue := fakeOCRQueue{
		enqueue: func(id, authorization string) {
			enqueued = append(enqueued, id)
			events = append(events, "enqueue")
			require.Equal(t, token("owner"), authorization)
			require.NoError(t, h.db.Do(t.Context(), false, func(tx *store.Tx) error {
				// Every card and the sheet must already be committed when the
				// first credential is handed to the worker.
				var cards, sheets int
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT (SELECT count(*) FROM cards),(SELECT count(*) FROM sheets)`).Scan(&cards, &sheets))
				require.Equal(t, 3, cards)
				require.Equal(t, 1, sheets)
				card, err := tx.Card(id, store.Viewer{ID: "owner"})
				require.NoError(t, err)
				require.Equal(t, "pending", card.OCRState)
				return nil
			}))
		},
		kick: func() { events = append(events, "kick") },
	}
	splitter := splitterFunc(func(ctx context.Context, data []byte, contentType string, width, height int, authorization string) ([]ocr.Region, error) {
		require.Equal(t, token("owner"), authorization)
		require.Equal(t, "image/jpeg", contentType)
		require.Equal(t, 1200, width)
		require.Equal(t, 900, height)
		deadline, ok := ctx.Deadline()
		require.True(t, ok)
		require.InDelta(t, 15, time.Until(deadline).Seconds(), 1)
		normalized = data
		regions := sheetRegions()
		return []ocr.Region{regions[2], regions[1], regions[0]}, nil
	})
	h.handler = New(h.db, h.auth, h.platform, nil, Options{ProjectID: "pj-test", OCR: OCRInfo{Available: true, SheetSplit: true}, Splitter: splitter, OCRQueue: queue})
	me := call[meResponse](h, "owner", "GET", "/me", nil, 200)
	require.True(t, me.OCR.SheetSplit)
	w, original := uploadSheetPNG(h, "")
	require.Equal(t, 202, w.Code, w.Body.String())
	var out uploadResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Len(t, out.Cards, 3)
	require.NotNil(t, out.Sheet)
	require.Equal(t, 3, out.Sheet.Detected)
	require.Equal(t, "/api/contacts/v1/sheets/"+out.Sheet.ID+"/image", out.Sheet.ImageURL)
	require.Equal(t, []string{"enqueue", "enqueue", "enqueue", "kick"}, events)
	wantImage, _, err := ocr.Normalize(original, "image/png")
	require.NoError(t, err)
	require.Equal(t, wantImage, normalized)
	for i, card := range out.Cards {
		require.Equal(t, card.ID, enqueued[i])
		require.Equal(t, &out.Sheet.ID, card.SheetID)
		region := sheetRegions()[i]
		require.Equal(t, &[4]int{region.X1, region.Y1, region.X2, region.Y2}, card.BBox)
		require.Nil(t, card.ContactID)
		require.Equal(t, "pending", card.OCRState)
		require.Equal(t, "owner", card.Owner.ID)
		require.Equal(t, "Conference", *card.Place)
		require.Equal(t, "2026-10-01T12:00:00Z", card.ExchangedAt.Format(time.RFC3339))
		got := call[domain.BusinessCard](h, "owner", "GET", "/cards/"+card.ID, nil, 200)
		require.Equal(t, card, got)
		crop := h.request("owner", "GET", "/cards/"+card.ID+"/image", nil, "", 0)
		require.Equal(t, 200, crop.Code)
		require.Equal(t, "image/jpeg", crop.Header().Get("Content-Type"))
		width, height, err := ocr.Decode(crop.Body.Bytes(), "image/jpeg")
		require.NoError(t, err)
		require.Equal(t, 500, width)
		require.Equal(t, 250, height)
	}
	// Linking a crop to a shared contact must not expose the whole sheet.
	linked := call[domain.Contact](h, "owner", "POST", "/cards/"+out.Cards[0].ID+"/confirm", map[string]any{"contact": map[string]string{"fullName": "Shared person"}}, 200)
	require.Equal(t, out.Sheet.ID, *linked.Cards[0].SheetID)
	call[domain.BusinessCard](h, "other", "GET", "/cards/"+out.Cards[0].ID, nil, 200)
	sheetPath := strings.TrimPrefix(out.Sheet.ImageURL, "/api/contacts/v1")
	call[httpx.Error](h, "other", "GET", sheetPath, nil, 404)
	for _, viewer := range []string{"owner", "admin"} {
		response := h.request(viewer, "GET", sheetPath, nil, "", 0)
		require.Equal(t, 200, response.Code, response.Body.String())
		require.Equal(t, "image/jpeg", response.Header().Get("Content-Type"))
		require.Equal(t, "private, max-age=3600", response.Header().Get("Cache-Control"))
		require.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))
		require.Equal(t, normalized, response.Body.Bytes())
	}
	for i, card := range out.Cards {
		call[any](h, "owner", "DELETE", "/cards/"+card.ID, nil, 204)
		response := h.request("admin", "GET", sheetPath, nil, "", 0)
		if i < len(out.Cards)-1 {
			require.Equal(t, 200, response.Code)
		} else {
			require.Equal(t, 404, response.Code)
		}
	}
	require.NoError(t, h.db.Do(t.Context(), false, func(tx *store.Tx) error {
		var remaining int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM sheets`).Scan(&remaining))
		require.Zero(t, remaining)
		return nil
	}))
}

func TestSheetUploadFallsBackToOriginalCard(t *testing.T) {
	for _, tc := range []struct {
		name       string
		regions    []ocr.Region
		err        error
		configured bool
	}{
		{name: "not configured"},
		{name: "one region", regions: sheetRegions()[:1], configured: true},
		{name: "no regions", configured: true},
		{name: "whole image", regions: append(sheetRegions(), ocr.Region{X2: 1200, Y2: 900}), configured: true},
		{name: "splitter error", err: errors.New("vision unavailable"), configured: true},
		{name: "splitter timeout", err: context.DeadlineExceeded, configured: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, fakeExtractor{})
			if tc.configured {
				h.handler.(*API).options.Splitter = splitterFunc(func(context.Context, []byte, string, int, int, string) ([]ocr.Region, error) {
					return tc.regions, tc.err
				})
			}
			w, original := uploadSheetPNG(h, "")
			require.Equal(t, 202, w.Code, w.Body.String())
			var out uploadResponse
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
			require.Len(t, out.Cards, 1)
			require.Nil(t, out.Sheet)
			require.Contains(t, w.Body.String(), `"sheet":null`)
			card := out.Cards[0]
			require.Nil(t, card.SheetID)
			require.Nil(t, card.BBox)
			require.Equal(t, "pending", card.OCRState)
			want, _, err := ocr.Normalize(original, "image/png")
			require.NoError(t, err)
			got := h.request("owner", "GET", "/cards/"+card.ID+"/image", nil, "", 0)
			require.Equal(t, 200, got.Code)
			require.Equal(t, want, got.Body.Bytes())
			require.NoError(t, h.db.Do(t.Context(), false, func(tx *store.Tx) error {
				var count int
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM sheets`).Scan(&count))
				require.Zero(t, count)
				return nil
			}))
		})
	}
}

func TestSheetUploadRejectsContactAndRollsBackFailedCards(t *testing.T) {
	for _, withContact := range []bool{true, false} {
		name := "card insert failure"
		if withContact {
			name = "contactId rejected"
		}
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, fakeExtractor{})
			h.handler.(*API).options.Splitter = splitterFunc(func(context.Context, []byte, string, int, int, string) ([]ocr.Region, error) {
				return sheetRegions(), nil
			})
			h.handler.(*API).options.OCRQueue = fakeOCRQueue{
				enqueue: func(string, string) { t.Error("failed upload must not enqueue") },
				kick:    func() { t.Error("failed upload must not kick") },
			}
			contactID := ""
			if withContact {
				contact := call[domain.Contact](h, "owner", "POST", "/contacts", map[string]string{"fullName": "Existing"}, 201)
				contactID = contact.ID
			} else {
				require.NoError(t, h.db.Do(t.Context(), true, func(tx *store.Tx) error {
					return tx.Exec(`ALTER TABLE cards ADD CONSTRAINT reject_second_crop CHECK (bbox[1] <> 650)`)
				}))
			}
			w, _ := uploadSheetPNG(h, contactID)
			require.Equal(t, 400, w.Code, w.Body.String())
			if withContact {
				var failure httpx.Error
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &failure))
				require.Equal(t, "sheet_with_contact", failure.Code)
			}
			require.NoError(t, h.db.Do(t.Context(), false, func(tx *store.Tx) error {
				var cards, sheets int
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT (SELECT count(*) FROM cards),(SELECT count(*) FROM sheets)`).Scan(&cards, &sheets))
				require.Zero(t, cards)
				require.Zero(t, sheets)
				return nil
			}))
		})
	}
}
