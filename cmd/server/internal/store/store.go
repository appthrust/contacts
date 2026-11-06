package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/contacts/cmd/server/internal/domain"
	"github.com/lib/pq"
	"github.com/oklog/ulid/v2"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct{ *pgstore.Store }
type Tx struct {
	*pgstore.Tx
	// Viewer scopes resolver reads to the same visibility as confirmation.
	Viewer Viewer
	source string
}
type Viewer struct {
	ID    string
	Admin bool
}
type scanner interface{ Scan(...any) error }
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

func Open(ctx context.Context, dsn string) (*Store, error) {
	db, err := pgstore.Open(ctx, dsn, migrations, "contacts_schema_migrations")
	if err != nil {
		return nil, err
	}
	return &Store{db}, nil
}
func (s *Store) Do(ctx context.Context, write bool, fn func(*Tx) error) error {
	return translate(s.Store.Do(ctx, write, func(tx *pgstore.Tx) error {
		return fn(&Tx{Tx: tx, source: "member"})
	}))
}
func translate(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return httpx.NotFound()
	}
	var pg *pq.Error
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			return httpx.Conflict("This value is already in use")
		case "23503", "23514":
			return httpx.Invalid("A referenced resource or value is invalid")
		}
	}
	return err
}
func ParseCursor(cursor string) (time.Time, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	parts := strings.Split(string(raw), "|")
	if err != nil || len(parts) != 2 {
		return time.Time{}, "", httpx.Invalid("Invalid cursor")
	}
	at, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, "", httpx.Invalid("Invalid cursor")
	}
	if _, err := ulid.ParseStrict(parts[1]); err != nil {
		return time.Time{}, "", httpx.Invalid("Invalid cursor")
	}
	return at, parts[1], nil
}
func cursorArgs(cursor string) (any, string, error) {
	if cursor == "" {
		return nil, "", nil
	}
	return ParseCursor(cursor)
}
func nextCursor(at time.Time, id string) *string {
	value := base64.RawURLEncoding.EncodeToString([]byte(at.Format(time.RFC3339Nano) + "|" + id))
	return &value
}

const memberColumns = `sub,display_name,email,directory_person_id,directory_checked_at`

func scanMember(row scanner) (m domain.Member, err error) {
	err = row.Scan(&m.ID, &m.DisplayName, &m.Email, &m.DirectoryPersonID, &m.DirectoryCheckedAt)
	return
}
func (t *Tx) Member(id string) (domain.Member, error) {
	return scanMember(t.SQL.QueryRowContext(t.Context, `SELECT `+memberColumns+` FROM members WHERE sub=$1`, id))
}
func (t *Tx) UpsertMember(id, name, email string) (domain.Member, error) {
	return scanMember(t.SQL.QueryRowContext(t.Context, `INSERT INTO members(sub,display_name,email) VALUES($1,$2,$3) ON CONFLICT(sub) DO UPDATE SET display_name=CASE WHEN members.directory_person_id IS NULL THEN excluded.display_name ELSE members.display_name END,email=excluded.email RETURNING `+memberColumns, id, name, email))
}
func (t *Tx) RefreshDirectory(id string, person *string, name string) (domain.Member, error) {
	return scanMember(t.SQL.QueryRowContext(t.Context, `UPDATE members SET directory_person_id=$2,display_name=CASE WHEN $2::text IS NOT NULL THEN $3 ELSE display_name END,directory_checked_at=now() WHERE sub=$1 RETURNING `+memberColumns, id, person, name))
}

// All contact queries bind viewer ID/admin in $1/$2 and use this exact predicate.
const visibleContact = `(c.visibility='shared' OR c.created_by_member_id=$1 OR $2 OR EXISTS(SELECT 1 FROM cards own WHERE own.contact_id=c.id AND own.owner_member_id=$1))`

func (t *Tx) Counts(v Viewer) (c domain.Counts, err error) {
	err = t.SQL.QueryRowContext(t.Context, `SELECT
		(SELECT count(*) FROM cards b WHERE b.owner_member_id=$1 AND (b.contact_id IS NULL OR EXISTS(SELECT 1 FROM contacts c WHERE c.id=b.contact_id AND `+visibleContact+`))),
		(SELECT count(*) FROM contacts c WHERE c.state<>'archived' AND `+visibleContact+` AND EXISTS(SELECT 1 FROM encounters e WHERE e.contact_id=c.id AND e.member_id=$1)),
		(SELECT count(*) FROM contacts c WHERE c.state<>'archived' AND `+visibleContact+`),
		(SELECT count(*) FROM companies WHERE merged_into_id IS NULL)`, v.ID, v.Admin).Scan(&c.MyCards, &c.MyContacts, &c.Contacts, &c.Companies)
	return
}
func (t *Tx) recordChange(id, actor string, diff domain.Diff, bump bool) error {
	if bump {
		if err := t.Exec(`UPDATE contacts SET version=version+1,updated_at=now() WHERE id=$1`, id); err != nil {
			return err
		}
	}
	raw, err := json.Marshal(diff)
	if err != nil {
		return err
	}
	return t.Exec(`INSERT INTO contact_changes(id,contact_id,actor_member_id,diff,source) VALUES($1,$2,$3,$4,$5)`, ulid.Make().String(), id, actor, raw, t.source)
}
func CheckVersion(c domain.Contact, expected int) error {
	if c.Version != expected {
		return httpx.Fail(409, "version_conflict", "The contact has changed; reload it before editing")
	}
	return nil
}
