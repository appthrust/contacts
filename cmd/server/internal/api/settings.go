package api

import (
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/registration"
)

func (a *API) settings(s *request) (any, int, error) {
	settings, err := s.tx.Settings()
	return settings, 200, err
}

func (a *API) putSettings(s *request) (any, int, error) {
	if err := requireAdmin(s); err != nil {
		return nil, 0, err
	}
	var settings registration.Settings
	if err := decode(s, &settings); err != nil {
		return nil, 0, err
	}
	if err := registration.Validate(settings); err != nil {
		return nil, 0, httpx.Invalid(err.Error())
	}
	if err := s.tx.PutSettings(settings, s.viewer); err != nil {
		return nil, 0, err
	}
	// Publish runtime preferences only after the settings transaction commits.
	s.settings = &settings
	return settings, 200, nil
}
