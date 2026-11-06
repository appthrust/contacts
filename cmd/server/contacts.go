package main

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/pending"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/contacts/cmd/server/internal/api"
	"github.com/appthrust/contacts/cmd/server/internal/ocr"
	"github.com/appthrust/contacts/cmd/server/internal/registration"
	"github.com/appthrust/contacts/cmd/server/internal/store"
)

const storeOpenTimeout = 30 * time.Second

var storeRetryInitial = time.Second

type runningStore struct {
	*store.Store
	cancel context.CancelFunc
	done   <-chan struct{}
}

func (s *runningStore) Close() error {
	s.cancel()
	<-s.done
	return s.Store.Close()
}
func contactsHandler(upstreamURL, projectID string) (*pending.Handler, func(), error) {
	auth, err := identity.New(identity.FromEnv("CONTACTS"))
	if err != nil {
		return nil, nil, err
	}
	if public := os.Getenv("CONTACTS_PUBLIC_URL"); public != "" {
		origin, err := parseOrigin(public)
		if err != nil || origin.Scheme != "https" || origin.Path != "" || strings.Contains(public, "#") {
			return nil, nil, errors.New("CONTACTS_PUBLIC_URL must be an HTTPS origin without a path, query, or fragment")
		}
	}
	if raw := os.Getenv("CONTACTS_DIRECTORY_URL"); raw != "" {
		origin, err := parseOrigin(raw)
		if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") {
			return nil, nil, errors.New("CONTACTS_DIRECTORY_URL must be an HTTP or HTTPS origin")
		}
	}
	releaseModel := os.Getenv("CONTACTS_LLM_MODEL")
	model := ocr.NewModelSelector(releaseModel)
	gateway, err := ocr.NewGatewayExtractor(os.Getenv("CONTACTS_LLM_URL"), model, auth.HTTPClient())
	if err != nil {
		return nil, nil, err
	}
	splitter, _ := ocr.NewGatewaySplitter(os.Getenv("CONTACTS_LLM_URL"), model, auth.HTTPClient())
	extractors := []ocr.Extractor{}
	if gateway != nil {
		extractors = append(extractors, gateway)
	}
	platform := platformclient.New(upstreamURL, projectID, platformclient.WithHTTPClient(auth.HTTPClient()))
	links := link.NewClient(link.NewResolver(platform, "contacts", os.LookupEnv, map[string]link.Required{"directory": {URLEnv: "CONTACTS_DIRECTORY_URL", PublicURLEnv: "CONTACTS_DIRECTORY_PUBLIC_URL"}}), nil)
	contacts := pending.Serve(api.Unavailable())
	dsn := os.Getenv("CONTACTS_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		contacts.Swap(api.Unavailable())
		return contacts, func() {}, nil
	}
	seed := os.Getenv("CONTACTS_DEV_SEED") == "1"
	stop := pending.Connect("contacts database", storeRetryInitial, func(lifetime context.Context) (io.Closer, error) {
		ctx, cancel := context.WithTimeout(lifetime, storeOpenTimeout)
		defer cancel()
		database, err := store.Open(ctx, dsn)
		if err != nil {
			return nil, err
		}
		if seed {
			if err = database.SeedDev(ctx); err != nil {
				_ = database.Close()
				return nil, err
			}
		}
		worker := ocr.NewWorker(database, extractors, registration.NewRegistrar(database), 1, 180*time.Second)
		var settings registration.Settings
		if err := database.Do(ctx, false, func(tx *store.Tx) error {
			var err error
			settings, err = tx.Settings()
			return err
		}); err != nil {
			_ = database.Close()
			return nil, err
		}
		model.Set(settings.OCRModel)
		worker.SetPreference(settings.ExtractorPreference)
		workerCtx, stopWorker := context.WithCancel(lifetime)
		done := make(chan struct{})
		go func() { defer close(done); worker.Run(workerCtx) }()
		extractorName := ""
		if gateway != nil {
			extractorName = gateway.Name()
		}
		contacts.Swap(api.New(database, auth, platform, links, api.Options{
			ProjectID: projectID, DirectoryPublicURL: os.Getenv("CONTACTS_DIRECTORY_PUBLIC_URL"),
			OCR: api.OCRInfo{
				Available: gateway != nil, Extractor: extractorName, ReleaseModel: releaseModel,
				Probe:      api.NewOCRLocalProbe(os.Getenv("CONTACTS_LLM_URL"), model.Current, auth.HTTPClient()),
				SheetSplit: splitter != nil,
			},
			OCRQueue: worker,
			Splitter: splitter,
			OnSettingsChanged: func(s registration.Settings) {
				model.Set(s.OCRModel)
				worker.SetPreference(s.ExtractorPreference)
			},
		}))
		return &runningStore{Store: database, cancel: stopWorker, done: done}, nil
	})
	return contacts, stop, nil
}
