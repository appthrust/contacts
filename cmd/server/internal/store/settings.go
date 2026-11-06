package store

import (
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
)

func (t *Tx) Settings() (domain.RegistrationSettings, error) {
	s := domain.DefaultRegistrationSettings()
	var raw []byte
	err := t.SQL.QueryRowContext(t.Context, `SELECT document FROM settings WHERE singleton`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(raw, &s)
	return s, err
}

func (t *Tx) PutSettings(s domain.RegistrationSettings, v Viewer) error {
	if !v.Admin {
		return httpx.Forbidden()
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return t.Exec(`INSERT INTO settings(singleton,document,updated_by) VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET document=excluded.document,updated_at=now(),updated_by=excluded.updated_by`, raw, v.ID)
}
