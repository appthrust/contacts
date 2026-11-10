package ocr

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
	"unicode/utf8"
)

type extractorFunc func(context.Context, []byte, string, string) (Extraction, error)

func (f extractorFunc) Name() string { return EngineGatewayVision }

func (f extractorFunc) Extract(ctx context.Context, image []byte, contentType string, authorization string) (Extraction, error) {
	return f(ctx, image, contentType, authorization)
}

type registrarFunc func(context.Context, string, Extraction, string) error

func (f registrarFunc) Register(ctx context.Context, cardID string, x Extraction, owner string) error {
	return f(ctx, cardID, x, owner)
}

type fakeRegistrar struct {
	calls atomic.Int32
	err   error
}

func (r *fakeRegistrar) Register(context.Context, string, Extraction, string) error {
	r.calls.Add(1)
	return r.err
}

type storedResult struct {
	id         string
	state      string
	extraction Extraction
	reason     string
}

type fakeStore struct {
	mu             sync.Mutex
	pending        []Card
	results        []storedResult
	claimTimes     []time.Time
	claimLimits    []int
	claimFailures  int
	writeFailures  int
	writePanics    int
	writes         int
	invalidContext bool
}

func (s *fakeStore) ClaimPendingCards(ctx context.Context, limit int, _ time.Duration) ([]Card, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.claimTimes = append(s.claimTimes, time.Now())
	s.claimLimits = append(s.claimLimits, limit)
	if s.claimFailures > 0 {
		s.claimFailures--
		return nil, errors.New("claim unavailable")
	}
	n := min(limit, len(s.pending))
	cards := s.pending[:n]
	s.pending = s.pending[n:]
	return cards, nil
}

func (s *fakeStore) RecordExtraction(ctx context.Context, id string, x Extraction) (Extraction, error) {
	x.ID = "extraction-" + id
	x.CreatedAt = time.Now()
	return x, s.record(ctx, storedResult{id: id, state: "done", extraction: x})
}

func (s *fakeStore) FailCard(ctx context.Context, id, reason string) error {
	return s.record(ctx, storedResult{id: id, state: "failed", reason: reason})
}

func (s *fakeStore) MarkUnavailable(ctx context.Context, id string) error {
	return s.record(ctx, storedResult{id: id, state: "unavailable"})
}

func (s *fakeStore) record(ctx context.Context, result storedResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writes++
	if err := ctx.Err(); err != nil {
		s.invalidContext = true
		return err
	}
	if s.writePanics > 0 {
		s.writePanics--
		panic("store panic")
	}
	if s.writeFailures > 0 {
		s.writeFailures--
		return errors.New("write unavailable")
	}
	s.results = append(s.results, result)
	return nil
}

func startWorker(t *testing.T, worker *Worker) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		worker.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return cancel
}

func TestWorkerCardOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name      string
		extractor Extractor
		state     string
		reason    string
	}{
		{"complete", extractorFunc(func(_ context.Context, image []byte, contentType string, authorization string) (Extraction, error) {
			if string(image) != "image" || contentType != "image/png" || authorization != "Bearer caller-token" {
				return Extraction{}, errors.New("wrong image or authorization input")
			}
			return Extraction{Fields: Fields{FullName: "山田 太郎"}, Overall: 0.9}, nil
		}), "done", ""},
		{"failed", extractorFunc(func(context.Context, []byte, string, string) (Extraction, error) {
			return Extraction{}, errors.New("cannot read card")
		}), "failed", "cannot read card"},
		{"unavailable", extractorFunc(func(context.Context, []byte, string, string) (Extraction, error) {
			return Extraction{}, fmt.Errorf("policy: %w", ErrUnavailable)
		}), "unavailable", ""},
		{"nil extractor", nil, "unavailable", ""},
		{"panic", extractorFunc(func(context.Context, []byte, string, string) (Extraction, error) {
			panic("extractor panic")
		}), "failed", "OCR extractor panic: extractor panic"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				store := &fakeStore{pending: []Card{{ID: "card", Image: []byte("image"), ContentType: "image/png"}}}
				registrar := &fakeRegistrar{}
				worker := NewWorker(store, []Extractor{tc.extractor}, registrar, 2, time.Minute)
				worker.Enqueue("card", "Bearer caller-token")
				startWorker(t, worker)
				synctest.Wait()
				store.mu.Lock()
				defer store.mu.Unlock()
				if len(store.results) != 1 || store.results[0].id != "card" || store.results[0].state != tc.state || store.results[0].reason != tc.reason {
					t.Fatalf("results=%+v, want %s/%s", store.results, tc.state, tc.reason)
				}
				if tc.state == "done" && store.results[0].extraction.Fields.FullName != "山田 太郎" {
					t.Fatalf("extraction not persisted: %+v", store.results[0].extraction)
				}
				wantCalls := int32(0)
				if tc.state == "done" {
					wantCalls = 1
				}
				if registrar.calls.Load() != wantCalls {
					t.Fatalf("registrar calls=%d, want %d", registrar.calls.Load(), wantCalls)
				}
			})
		})
	}
}

func TestWorkerRequiresEnqueuedAuthorization(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := &fakeStore{pending: []Card{{ID: "missing"}, {ID: "empty"}}}
		var calls atomic.Int32
		extractor := extractorFunc(func(context.Context, []byte, string, string) (Extraction, error) {
			calls.Add(1)
			return Extraction{}, nil
		})
		worker := NewWorker(store, []Extractor{extractor}, &fakeRegistrar{}, 2, time.Minute)
		worker.Enqueue("empty", "")
		startWorker(t, worker)
		synctest.Wait()
		store.mu.Lock()
		defer store.mu.Unlock()
		if calls.Load() != 0 || len(store.results) != 2 {
			t.Fatalf("calls=%d results=%+v, want unavailable without reading", calls.Load(), store.results)
		}
		for _, result := range store.results {
			if result.state != "unavailable" || result.reason != "" {
				t.Errorf("card without authorization: %+v", result)
			}
		}
	})
}

func TestWorkerConsumesAuthorizationAndAcceptsFreshRetry(t *testing.T) {
	store := &fakeStore{}
	var authorizations []string
	extractor := extractorFunc(func(_ context.Context, _ []byte, _ string, authorization string) (Extraction, error) {
		authorizations = append(authorizations, authorization)
		return Extraction{Fields: Fields{FullName: "Alice"}}, nil
	})
	worker := NewWorker(store, []Extractor{extractor}, &fakeRegistrar{}, 1, time.Minute)
	card := Card{ID: "card"}
	worker.Enqueue(card.ID, "Bearer first-token")
	if worker.processCard(t.Context(), card) || worker.processCard(t.Context(), card) {
		t.Fatal("unexpected store error")
	}
	worker.Enqueue(card.ID, "Bearer fresh-token")
	if worker.processCard(t.Context(), card) {
		t.Fatal("unexpected retry store error")
	}
	if len(authorizations) != 2 || authorizations[0] != "Bearer first-token" || authorizations[1] != "Bearer fresh-token" {
		t.Fatalf("unexpected extractor authorizations: %v", authorizations)
	}
	if len(store.results) != 3 || store.results[0].state != "done" || store.results[1].state != "unavailable" || store.results[2].state != "done" {
		t.Fatalf("unexpected card outcomes: %+v", store.results)
	}
}

func TestWorkerTruncatesFailureByCharacters(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := &fakeStore{pending: []Card{{ID: "card"}}}
		extractor := extractorFunc(func(context.Context, []byte, string, string) (Extraction, error) {
			return Extraction{}, errors.New(strings.Repeat("名", 510))
		})
		worker := NewWorker(store, []Extractor{extractor}, &fakeRegistrar{}, 1, time.Minute)
		worker.Enqueue("card", "Bearer caller-token")
		startWorker(t, worker)
		synctest.Wait()
		store.mu.Lock()
		defer store.mu.Unlock()
		if len(store.results) != 1 || store.results[0].reason != strings.Repeat("名", 500) || !utf8.ValidString(store.results[0].reason) {
			t.Fatalf("invalid truncated failure: %+v", store.results)
		}
	})
}

func TestWorkerKickAndPoll(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := &fakeStore{}
		worker := NewWorker(store, nil, &fakeRegistrar{}, 2, time.Minute)
		startWorker(t, worker)
		synctest.Wait()
		start := time.Now()
		store.mu.Lock()
		store.pending = append(store.pending, Card{ID: "kick"})
		store.mu.Unlock()
		for range 100 {
			worker.Kick()
		}
		synctest.Wait()
		store.mu.Lock()
		if len(store.results) != 1 || store.results[0].id != "kick" || time.Since(start) != 0 {
			t.Errorf("Kick did not wake immediately: results=%+v elapsed=%v", store.results, time.Since(start))
		}
		store.pending = append(store.pending, Card{ID: "poll"})
		store.mu.Unlock()
		time.Sleep(5 * time.Second)
		synctest.Wait()
		store.mu.Lock()
		defer store.mu.Unlock()
		if len(store.results) != 2 || store.results[1].id != "poll" {
			t.Fatalf("poll did not discover card: %+v", store.results)
		}
	})
}

func TestWorkerConcurrency(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := &fakeStore{pending: []Card{{ID: "1"}, {ID: "2"}, {ID: "3"}, {ID: "4"}, {ID: "5"}}}
		var active, started atomic.Int32
		var exceeded atomic.Bool
		release := make(chan struct{})
		extractor := extractorFunc(func(ctx context.Context, _ []byte, _ string, _ string) (Extraction, error) {
			if active.Add(1) > 2 {
				exceeded.Store(true)
			}
			defer active.Add(-1)
			started.Add(1)
			select {
			case <-release:
				return Extraction{}, nil
			case <-ctx.Done():
				return Extraction{}, ctx.Err()
			}
		})
		worker := NewWorker(store, []Extractor{extractor}, &fakeRegistrar{}, 2, time.Minute)
		for _, card := range store.pending {
			worker.Enqueue(card.ID, "Bearer caller-token")
		}
		startWorker(t, worker)
		synctest.Wait()
		if active.Load() != 2 || started.Load() != 2 {
			t.Fatalf("active=%d started=%d, want two occupied slots", active.Load(), started.Load())
		}
		release <- struct{}{}
		synctest.Wait()
		if active.Load() != 2 || started.Load() != 3 {
			t.Fatalf("free slot not refilled: active=%d started=%d", active.Load(), started.Load())
		}
		close(release)
		synctest.Wait()
		store.mu.Lock()
		defer store.mu.Unlock()
		if exceeded.Load() || len(store.results) != 5 || active.Load() != 0 {
			t.Fatalf("exceeded=%v active=%d results=%+v", exceeded.Load(), active.Load(), store.results)
		}
		for _, limit := range store.claimLimits {
			if limit < 1 || limit > 2 {
				t.Errorf("claim limit=%d, want [1,2]", limit)
			}
		}
	})
}

func TestWorkerPerCardTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := &fakeStore{pending: []Card{{ID: "timeout"}, {ID: "next"}}}
		var calls atomic.Int32
		extractor := extractorFunc(func(ctx context.Context, _ []byte, _ string, _ string) (Extraction, error) {
			if calls.Add(1) == 1 {
				<-ctx.Done()
				return Extraction{}, ctx.Err()
			}
			return Extraction{Fields: Fields{FullName: "next"}}, nil
		})
		worker := NewWorker(store, []Extractor{extractor}, &fakeRegistrar{}, 1, 2*time.Second)
		for _, card := range store.pending {
			worker.Enqueue(card.ID, "Bearer caller-token")
		}
		startWorker(t, worker)
		synctest.Wait()
		time.Sleep(2 * time.Second)
		synctest.Wait()
		store.mu.Lock()
		defer store.mu.Unlock()
		if len(store.results) != 2 || store.results[0].state != "failed" || store.results[0].reason != context.DeadlineExceeded.Error() || store.results[1].state != "done" || store.invalidContext {
			t.Fatalf("deadline outcome not persisted, or next card blocked: results=%+v invalidContext=%v", store.results, store.invalidContext)
		}
	})
}

func TestWorkerBacksOffStoreErrors(t *testing.T) {
	for _, failure := range []string{"claim", "write", "panic"} {
		t.Run(failure, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				store := &fakeStore{pending: []Card{{ID: "first"}, {ID: "next"}}}
				switch failure {
				case "claim":
					store.claimFailures = 1
				case "write":
					store.writeFailures = 1
				case "panic":
					store.writePanics = 1
				}
				worker := NewWorker(store, nil, &fakeRegistrar{}, 1, time.Minute)
				startWorker(t, worker)
				synctest.Wait()
				worker.Kick()
				time.Sleep(4 * time.Second)
				synctest.Wait()
				store.mu.Lock()
				if len(store.claimTimes) != 1 {
					t.Errorf("store error retried before 5s: %v", store.claimTimes)
				}
				store.mu.Unlock()
				time.Sleep(time.Second)
				synctest.Wait()
				store.mu.Lock()
				defer store.mu.Unlock()
				if len(store.results) == 0 || store.results[len(store.results)-1].id != "next" || len(store.claimTimes) < 2 || store.claimTimes[1].Sub(store.claimTimes[0]) != 5*time.Second {
					t.Fatalf("worker did not resume after backoff: results=%+v claims=%v", store.results, store.claimTimes)
				}
			})
		})
	}
}

func TestWorkerCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := &fakeStore{pending: []Card{{ID: "card"}}}
		extractor := extractorFunc(func(ctx context.Context, _ []byte, _ string, _ string) (Extraction, error) {
			<-ctx.Done()
			return Extraction{}, ctx.Err()
		})
		worker := NewWorker(store, []Extractor{extractor}, &fakeRegistrar{}, 1, time.Minute)
		worker.Enqueue("card", "Bearer caller-token")
		cancel := startWorker(t, worker)
		synctest.Wait()
		cancel()
		synctest.Wait()
		store.mu.Lock()
		defer store.mu.Unlock()
		if store.writes != 0 {
			t.Fatalf("shutdown attempted to persist using canceled context: writes=%d", store.writes)
		}
	})
}

func TestWorkerRegistersPersistedExtractionWithOwner(t *testing.T) {
	store := &fakeStore{}
	extracted := Extraction{Engine: EngineGatewayVision, Model: "model", Fields: Fields{FullName: "Alice"}, Overall: 0.9}
	extractor := extractorFunc(func(context.Context, []byte, string, string) (Extraction, error) {
		return extracted, nil
	})
	calls := 0
	registrar := registrarFunc(func(ctx context.Context, cardID string, x Extraction, owner string) error {
		calls++
		if ctx.Err() != nil || cardID != "card" || owner != "member" {
			t.Errorf("registration context=%v card=%q owner=%q", ctx.Err(), cardID, owner)
		}
		if len(store.results) != 1 || store.results[0].state != "done" || !reflect.DeepEqual(x, store.results[0].extraction) {
			t.Errorf("registration must follow persistence: extraction=%+v results=%+v", x, store.results)
		}
		if x.ID != "extraction-card" || x.CreatedAt.IsZero() || x.Engine != extracted.Engine || x.Model != extracted.Model || x.Overall != extracted.Overall {
			t.Errorf("registration did not receive the stored extraction: %+v", x)
		}
		return nil
	})
	worker := NewWorker(store, []Extractor{extractor}, registrar, 1, time.Minute)
	worker.Enqueue("card", "Bearer caller-token")
	if worker.processCard(t.Context(), Card{ID: "card", OwnerMemberID: "member"}) || calls != 1 {
		t.Fatalf("registration calls=%d, want one successful registration", calls)
	}
}

func TestWorkerRegistrationFailureKeepsExtractionDone(t *testing.T) {
	for _, panicRegistration := range []bool{false, true} {
		t.Run(fmt.Sprintf("panic=%v", panicRegistration), func(t *testing.T) {
			store := &fakeStore{}
			extractor := extractorFunc(func(context.Context, []byte, string, string) (Extraction, error) {
				return Extraction{Fields: Fields{FullName: "Alice"}}, nil
			})
			calls := 0
			registrar := registrarFunc(func(context.Context, string, Extraction, string) error {
				calls++
				if panicRegistration {
					panic("registration panic")
				}
				return errors.New("registration failed")
			})
			worker := NewWorker(store, []Extractor{extractor}, registrar, 1, time.Minute)
			worker.Enqueue("card", "Bearer caller-token")
			if worker.processCard(t.Context(), Card{ID: "card"}) {
				t.Fatal("registration failure must not trigger store backoff")
			}
			if calls != 1 || store.writes != 1 || len(store.results) != 1 || store.results[0].state != "done" {
				t.Fatalf("registration failure changed OCR state: calls=%d writes=%d results=%+v", calls, store.writes, store.results)
			}
		})
	}
}

func TestWorkerDoesNotRegisterFailedPersistence(t *testing.T) {
	store := &fakeStore{writeFailures: 1}
	extractor := extractorFunc(func(context.Context, []byte, string, string) (Extraction, error) {
		return Extraction{}, nil
	})
	registrar := &fakeRegistrar{}
	worker := NewWorker(store, []Extractor{extractor}, registrar, 1, time.Minute)
	worker.Enqueue("card", "Bearer caller-token")
	if !worker.processCard(t.Context(), Card{ID: "card"}) {
		t.Fatal("failed persistence must trigger store backoff")
	}
	if registrar.calls.Load() != 0 || len(store.results) != 0 {
		t.Fatalf("unpersisted extraction registered: calls=%d results=%+v", registrar.calls.Load(), store.results)
	}
}

type namedExtractor struct {
	name string
	extractorFunc
}

func (e *namedExtractor) Name() string { return e.name }

func TestSelect(t *testing.T) {
	first := &namedExtractor{name: "first"}
	second := &namedExtractor{name: "second"}
	for _, tc := range []struct {
		name       string
		preference []string
		available  []Extractor
		want       Extractor
	}{
		{"none available", nil, nil, nil},
		{"preferred unavailable", []string{"missing"}, []Extractor{first, second}, nil},
		{"empty preference", nil, []Extractor{first, second}, first},
		{"preference order", []string{"second", "first"}, []Extractor{first, second}, second},
		{"skip unavailable", []string{"missing", "second"}, []Extractor{first, second}, second},
		{"nil unavailable", nil, []Extractor{nil, second}, second},
		{"named after nil", []string{"second"}, []Extractor{nil, second}, second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Select(tc.preference, tc.available); got != tc.want {
				t.Fatalf("selected=%v, want %v", got, tc.want)
			}
		})
	}
}

func TestWorkerPreference(t *testing.T) {
	store := &fakeStore{}
	first := &namedExtractor{name: "first", extractorFunc: func(context.Context, []byte, string, string) (Extraction, error) {
		return Extraction{Engine: "first"}, nil
	}}
	second := &namedExtractor{name: "second", extractorFunc: func(context.Context, []byte, string, string) (Extraction, error) {
		return Extraction{Engine: "second"}, nil
	}}
	worker := NewWorker(store, []Extractor{first, second}, &fakeRegistrar{}, 1, time.Minute)
	process := func(id string) {
		t.Helper()
		worker.Enqueue(id, "Bearer caller-token")
		if worker.processCard(t.Context(), Card{ID: id}) {
			t.Fatal("unexpected store error")
		}
	}
	process("default")
	preference := []string{"second", "first"}
	worker.SetPreference(preference)
	preference[0] = "first"
	process("preferred")
	worker.SetPreference([]string{"missing"})
	process("unavailable")
	worker.SetPreference(nil)
	process("reset")
	if len(store.results) != 4 || store.results[0].extraction.Engine != "first" || store.results[1].extraction.Engine != "second" || store.results[2].state != "unavailable" || store.results[3].extraction.Engine != "first" {
		t.Fatalf("unexpected preference results: %+v", store.results)
	}
}

func TestWorkerNoExtractors(t *testing.T) {
	store := &fakeStore{}
	registrar := &fakeRegistrar{}
	worker := NewWorker(store, nil, registrar, 1, time.Minute)
	worker.Enqueue("card", "Bearer caller-token")
	if worker.processCard(t.Context(), Card{ID: "card"}) || len(store.results) != 1 || store.results[0].state != "unavailable" || registrar.calls.Load() != 0 {
		t.Fatalf("missing extractor did not become unavailable: results=%+v calls=%d", store.results, registrar.calls.Load())
	}
}

func TestNewWorkerHonorsCallerLimits(t *testing.T) {
	worker := NewWorker(&fakeStore{}, nil, &fakeRegistrar{}, 3, 180*time.Second)
	if worker.concurrency != 3 || worker.perCard != 180*time.Second {
		t.Fatalf("limits changed: concurrency=%d perCard=%v", worker.concurrency, worker.perCard)
	}
	worker = NewWorker(&fakeStore{}, nil, &fakeRegistrar{}, 0, 0)
	if worker.concurrency != 0 || worker.perCard != 0 {
		t.Fatalf("unexpected implicit defaults: concurrency=%d perCard=%v", worker.concurrency, worker.perCard)
	}
}
