package api

import (
	"context"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/store"
)

const maxImageBytes = 5 << 20

type uploadSheet struct {
	ID       string `json:"id"`
	Detected int    `json:"detected"`
	ImageURL string `json:"imageUrl"`
}

type uploadResponse struct {
	Cards []domain.BusinessCard `json:"cards"`
	Sheet *uploadSheet          `json:"sheet"`
}

type ocrQueue interface {
	Enqueue(id, auth string)
	Forget(id string)
	Kick()
}

func imageTooLarge() error {
	return httpx.Fail(413, "image_too_large", "The image must be at most 5 MiB")
}
func (a *API) upload(s *request) (any, int, error) {
	// Bound both the complete multipart body and the image. Metadata gets a
	// separate small allowance; parsing never spills unbounded data to disk.
	s.r.Body = http.MaxBytesReader(s.w, s.r.Body, maxImageBytes+(64<<10))
	if err := s.r.ParseMultipartForm(maxImageBytes + (64 << 10)); err != nil {
		if s.r.MultipartForm != nil {
			defer s.r.MultipartForm.RemoveAll()
		}
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			return nil, 0, imageTooLarge()
		}
		return nil, 0, httpx.Invalid("Expected multipart/form-data with an image")
	}
	defer s.r.MultipartForm.RemoveAll()
	if len(s.r.MultipartForm.File["image"]) != 1 {
		return nil, 0, httpx.Invalid("Exactly one image is required")
	}
	file, header, err := s.r.FormFile("image")
	if err != nil {
		return nil, 0, httpx.Invalid("An image is required")
	}
	defer file.Close()
	if header.Size > maxImageBytes {
		return nil, 0, imageTooLarge()
	}
	image, err := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
	if err != nil {
		return nil, 0, httpx.Invalid("Cannot read image")
	}
	if len(image) > maxImageBytes {
		return nil, 0, imageTooLarge()
	}
	contentType, _, err := mime.ParseMediaType(header.Header.Get("Content-Type"))
	if err != nil {
		return nil, 0, httpx.Fail(415, "unsupported_image", "Use a JPEG, PNG, WebP or HEIC image")
	}
	image, contentType, err = ocr.Normalize(image, contentType)
	if err != nil {
		if errors.Is(err, ocr.ErrUnsupported) {
			return nil, 0, httpx.Fail(415, "unsupported_image", "Use a JPEG, PNG, WebP or HEIC image")
		}
		return nil, 0, httpx.Invalid("The image could not be decoded")
	}
	var exchangedAt *time.Time
	if value := s.r.FormValue("exchangedAt"); value != "" {
		at, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return nil, 0, httpx.Invalid("exchangedAt must be an RFC 3339 timestamp")
		}
		at = at.UTC()
		exchangedAt = &at
	}
	contactID := domain.Nullable(s.r.FormValue("contactId"))
	place := domain.Nullable(s.r.FormValue("place"))
	if a.options.Splitter != nil && s.bearer != "" && (contentType == "image/jpeg" || contentType == "image/png") {
		width, height, splitErr := ocr.Decode(image, contentType)
		var regions []ocr.Region
		if splitErr == nil {
			ctx, cancel := context.WithTimeout(s.r.Context(), 15*time.Second)
			regions, splitErr = a.options.Splitter.Split(ctx, image, contentType, width, height, s.bearer)
			cancel()
		}
		if splitErr != nil {
			log.Printf("contacts sheet split: falling back to one card: %v", splitErr)
		} else if regions = ocr.FilterRegions(regions, width, height); len(regions) >= 2 {
			if contactID != nil {
				return nil, 0, httpx.Fail(400, "sheet_with_contact", "A sheet cannot be attached to a single contact")
			}
			sheet, err := s.tx.CreateSheet(image, contentType, len(regions), s.viewer)
			if err != nil {
				return nil, 0, err
			}
			out := uploadResponse{
				Cards: make([]domain.BusinessCard, 0, len(regions)),
				Sheet: &uploadSheet{ID: sheet.ID, Detected: sheet.Detected, ImageURL: "/api/contacts/v1/sheets/" + sheet.ID + "/image"},
			}
			s.ocrCardIDs = make([]string, 0, len(regions))
			for _, region := range regions {
				crop, cropType, err := ocr.Crop(image, contentType, region)
				if err != nil {
					return nil, 0, err
				}
				ref := &store.SheetRef{ID: sheet.ID, BBox: [4]int{region.X1, region.Y1, region.X2, region.Y2}}
				card, err := s.tx.CreateCard(crop, cropType, nil, exchangedAt, place, ref, s.viewer)
				if err != nil {
					return nil, 0, err
				}
				out.Cards = append(out.Cards, card)
				s.ocrCardIDs = append(s.ocrCardIDs, card.ID)
			}
			return out, 202, nil
		}
	}
	card, err := s.tx.CreateCard(image, contentType, contactID, exchangedAt, place, nil, s.viewer)
	if err != nil {
		return nil, 0, err
	}
	if card.OCRState == "pending" {
		s.ocrCardIDs = []string{card.ID}
	}
	return uploadResponse{Cards: []domain.BusinessCard{card}}, 202, nil
}
func (a *API) cards(s *request) (any, int, error) {
	n, err := limit(s)
	if err != nil {
		return nil, 0, err
	}
	owner := s.r.URL.Query().Get("owner")
	if owner != "" && owner != "me" && owner != "all" {
		return nil, 0, httpx.Invalid("Owner must be me or all")
	}
	if owner == "all" {
		if err = requireAdmin(s); err != nil {
			return nil, 0, err
		}
	}
	page, err := s.tx.Cards(owner == "all", s.r.URL.Query().Get("cursor"), n, s.viewer)
	return page, 200, err
}
func (a *API) card(s *request) (any, int, error) {
	card, err := s.tx.Card(s.r.PathValue("id"), s.viewer)
	return card, 200, err
}
func (a *API) image(s *request) (any, int, error) {
	image, contentType, err := s.tx.CardImage(s.r.PathValue("id"), s.viewer)
	return rawResponse{body: image, contentType: contentType, cacheControl: "private, max-age=3600"}, 200, err
}
func (a *API) sheetImage(s *request) (any, int, error) {
	sheet, err := s.tx.Sheet(s.r.PathValue("id"), s.viewer)
	return rawResponse{body: sheet.Image, contentType: sheet.ContentType, cacheControl: "private, max-age=3600"}, 200, err
}
func (a *API) confirm(s *request) (any, int, error) {
	var input struct {
		ContactID   *string              `json:"contactId"`
		Contact     *domain.ContactInput `json:"contact"`
		CompanyName *string              `json:"companyName"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if (input.ContactID == nil) == (input.Contact == nil) || (input.ContactID != nil && *input.ContactID == "") {
		return nil, 0, httpx.Invalid("Provide exactly one of contactId or contact")
	}
	contact, err := s.tx.ConfirmCard(s.r.PathValue("id"), input.ContactID, input.Contact, input.CompanyName, s.viewer, "member")
	return contact, 200, err
}
func (a *API) retryOCR(s *request) (any, int, error) {
	if !a.options.OCR.Available {
		return nil, 0, httpx.Fail(409, "ocr_unavailable", "OCR is not available; enter the card details manually")
	}
	card, err := s.tx.RetryOCR(s.r.PathValue("id"), s.viewer)
	if err == nil {
		s.ocrCardIDs = []string{card.ID}
	}
	return card, 202, err
}
func (a *API) unlinkCard(s *request) (any, int, error) {
	if s.key {
		return nil, 0, httpx.Fail(403, "key_not_permitted", "Access keys cannot unlink cards")
	}
	card, err := s.tx.UnlinkCard(s.r.PathValue("id"), s.viewer)
	return card, 200, err
}
func (a *API) deleteCard(s *request) (any, int, error) {
	return nil, 204, s.tx.DeleteCard(s.r.PathValue("id"), s.viewer)
}
