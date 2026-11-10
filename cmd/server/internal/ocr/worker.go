package ocr

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

type Card struct {
	ID            string
	Image         []byte
	ContentType   string
	OwnerMemberID string
}

// Store atomically claims pending cards and persists their terminal OCR state.
// A claim keeps the external state pending for lease; after that the store may
// hand the card out again so interrupted processing or failed terminal writes
// can be recovered.
type Store interface {
	ClaimPendingCards(ctx context.Context, limit int, lease time.Duration) ([]Card, error)
	RecordExtraction(ctx context.Context, cardID string, x Extraction) (Extraction, error)
	FailCard(ctx context.Context, id string, reason string) error
	MarkUnavailable(ctx context.Context, id string) error
}

// Registrar resolves and registers an extraction after it has been persisted.
type Registrar interface {
	Register(ctx context.Context, cardID string, x Extraction, authorizationOwner string) error
}

type Worker struct {
	store       Store
	extractors  []Extractor
	registrar   Registrar
	preference  atomic.Value
	concurrency int
	perCard     time.Duration
	kick        chan struct{}
	bearers     sync.Map
}

// NewWorker uses the caller's concurrency and per-card deadline without defaults.
// Concurrency must be positive. No available extractor records unavailable.
func NewWorker(store Store, extractors []Extractor, registrar Registrar, concurrency int, perCard time.Duration) *Worker {
	return &Worker{store: store, extractors: extractors, registrar: registrar, concurrency: concurrency, perCard: perCard, kick: make(chan struct{}, 1)}
}

// SetPreference replaces the extractor preference for subsequently claimed cards.
// An empty preference accepts every available extractor.
func (w *Worker) SetPreference(names []string) {
	w.preference.Store(slices.Clone(names))
}

// Enqueue keeps the caller's credential only in memory until this worker claims
// the card. Call it before the card's transaction commits, so the credential is
// present whenever the card can be claimed; Forget it if the commit fails, and
// Kick after a successful commit to wake the worker.
func (w *Worker) Enqueue(cardID, authorization string) {
	w.bearers.Store(cardID, authorization)
}

// Forget drops the credential of a card whose transaction did not commit.
func (w *Worker) Forget(cardID string) {
	w.bearers.Delete(cardID)
}

// Kick coalesces upload notifications without blocking their request handlers.
func (w *Worker) Kick() {
	select {
	case w.kick <- struct{}{}:
	default:
	}
}

const pollInterval = 5 * time.Second

// claimLease outlives one card's worst case: extraction and the terminal write
// are each bounded by perCard, so a card still being read is never reclaimed.
func (w *Worker) claimLease() time.Duration { return 2*w.perCard + pollInterval }

// Run claims immediately, on Kick, and every five seconds while idle. It must
// have only one caller at a time. Only free processing slots are claimed, so
// cards never spend their processing deadline waiting in an in-memory queue.
// Store errors back off five seconds even if more uploads arrive meanwhile.
func (w *Worker) Run(ctx context.Context) {
	jobs := make(chan Card)
	results := make(chan bool, w.concurrency)
	var workers sync.WaitGroup
	for range w.concurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for card := range jobs {
				results <- w.processCard(ctx, card)
			}
		}()
	}
	defer func() {
		close(jobs)
		workers.Wait()
	}()
	timer := time.NewTimer(pollInterval)
	defer timer.Stop()
	active := 0
	claim, backingOff := true, false
	for {
		if ctx.Err() != nil {
			return
		}
		if claim && !backingOff && active < w.concurrency {
			cards, err := w.store.ClaimPendingCards(ctx, w.concurrency-active, w.claimLease())
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Printf("contacts OCR claim: %v", err)
				claim, backingOff = false, true
				timer.Reset(pollInterval)
			} else if len(cards) == 0 {
				claim = false
				timer.Reset(pollInterval)
			} else {
				for _, card := range cards {
					select {
					case jobs <- card:
						active++
					case <-ctx.Done():
						return
					}
				}
				continue
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			claim, backingOff = true, false
		case <-w.kick:
			if !backingOff {
				claim = true
			}
		case storeError := <-results:
			active--
			if storeError {
				claim, backingOff = false, true
				timer.Reset(pollInterval)
			} else if !backingOff {
				claim = true
			}
		}
	}
}

func (w *Worker) processCard(ctx context.Context, card Card) (storeError bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("contacts OCR card %q store panic: %v", card.ID, recovered)
			storeError = true
		}
	}()
	x, err := Extraction{}, ErrUnavailable
	if authorization, ok := w.bearers.LoadAndDelete(card.ID); ok {
		x, err = w.extractCard(ctx, card, authorization.(string))
	}
	if ctx.Err() != nil {
		return false
	}
	// An expired extractor context cannot persist its own failure. Give the store
	// a fresh bounded context, still canceled immediately when Run shuts down.
	writeCtx, cancel := context.WithTimeout(ctx, w.perCard)
	defer cancel()
	var persistErr error
	switch {
	case errors.Is(err, ErrUnavailable):
		persistErr = w.store.MarkUnavailable(writeCtx, card.ID)
	case err != nil:
		persistErr = w.store.FailCard(writeCtx, card.ID, truncateReason(err.Error()))
	default:
		x, persistErr = w.store.RecordExtraction(writeCtx, card.ID, x)
	}
	if persistErr != nil {
		log.Printf("contacts OCR card %q store: %v", card.ID, persistErr)
		return true
	}
	if err == nil {
		if registerErr := w.registerCard(writeCtx, card, x); registerErr != nil {
			// Extraction succeeded: leave the card done with no decision so it
			// remains reviewable rather than turning a registration error into
			// an extraction failure.
			log.Printf("contacts OCR card %q registration: %v", card.ID, registerErr)
		}
	}
	return false
}

func (w *Worker) extractCard(ctx context.Context, card Card, authorization string) (x Extraction, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("OCR extractor panic: %v", recovered)
		}
	}()
	ctx, cancel := context.WithTimeout(ctx, w.perCard)
	defer cancel()
	if authorization == "" {
		return Extraction{}, ErrUnavailable
	}
	preference, _ := w.preference.Load().([]string)
	extractor := Select(preference, w.extractors)
	if extractor == nil {
		return Extraction{}, ErrUnavailable
	}
	x, err = extractor.Extract(ctx, card.Image, card.ContentType, authorization)
	if err == nil {
		err = ctx.Err()
	}
	return x, err
}

func (w *Worker) registerCard(ctx context.Context, card Card, x Extraction) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("OCR registrar panic: %v", recovered)
		}
	}()
	return w.registrar.Register(ctx, card.ID, x, card.OwnerMemberID)
}

func truncateReason(reason string) string {
	characters := 0
	for offset := range reason {
		if characters == 500 {
			return reason[:offset]
		}
		characters++
	}
	return reason
}
