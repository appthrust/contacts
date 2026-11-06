CREATE TABLE members (
    sub text PRIMARY KEY,
    display_name text NOT NULL,
    email text NOT NULL,
    directory_person_id text,
    directory_checked_at timestamptz
);
CREATE TABLE companies (
    id text PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    normalized_name text NOT NULL,
    domain text,
    address text,
    url text,
    merged_into_id text REFERENCES companies(id) CHECK (merged_into_id <> id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_name ON companies(normalized_name) WHERE merged_into_id IS NULL;

-- Resolve company redirects without rewriting contacts (C3). UNION also
-- terminates defensively if corrupt external data ever introduces a cycle.
CREATE FUNCTION contacts_company_root(company_id text) RETURNS text
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE chain AS (
        SELECT id, merged_into_id FROM companies WHERE id = company_id
        UNION
        SELECT c.id, c.merged_into_id FROM companies c JOIN chain p ON c.id = p.merged_into_id
    ) SELECT id FROM chain WHERE merged_into_id IS NULL
$$;
-- array_to_string is marked STABLE upstream; this text-only wrapper has no
-- locale/timezone-sensitive elements and is safe in the generated FTS column.
CREATE FUNCTION contacts_email_text(emails text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string(emails, ' ') $$;
CREATE TABLE contacts (
    id text PRIMARY KEY,
    company_id text REFERENCES companies(id),
    company_search text NOT NULL DEFAULT '',
    full_name text NOT NULL CHECK (length(btrim(full_name)) > 0),
    normalized_name text NOT NULL,
    kana text,
    title text,
    department text,
    emails text[] NOT NULL DEFAULT '{}',
    email_domains text[] NOT NULL DEFAULT '{}',
    phones text[] NOT NULL DEFAULT '{}',
    address text,
    notes text,
    visibility text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','private')),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('draft','active','archived')),
    created_by_member_id text NOT NULL REFERENCES members(sub),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,
        full_name || ' ' || coalesce(kana,'') || ' ' || company_search || ' ' || coalesce(contacts_email_text(emails),''))) STORED
);
CREATE INDEX contacts_search ON contacts USING gin(search);
CREATE INDEX contacts_page ON contacts(updated_at DESC,id DESC);
CREATE INDEX contacts_duplicates ON contacts(normalized_name);
CREATE INDEX contacts_company ON contacts(company_id);
CREATE TABLE cards (
    id text PRIMARY KEY,
    contact_id text REFERENCES contacts(id),
    owner_member_id text NOT NULL REFERENCES members(sub),
    image bytea NOT NULL,
    image_content_type text NOT NULL,
    ocr_state text NOT NULL DEFAULT 'pending' CHECK (ocr_state IN ('pending','done','failed','unavailable')),
    ocr_fields jsonb,
    ocr_error text,
    claimed_at timestamptz,
    exchanged_at timestamptz,
    place text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cards_pending ON cards(claimed_at,created_at) WHERE ocr_state='pending';
CREATE INDEX cards_contact ON cards(contact_id);
CREATE INDEX cards_owner ON cards(owner_member_id,created_at DESC,id DESC);
CREATE TABLE encounters (
    contact_id text NOT NULL REFERENCES contacts(id),
    member_id text NOT NULL REFERENCES members(sub),
    first_at timestamptz NOT NULL,
    last_at timestamptz NOT NULL,
    card_count integer NOT NULL CHECK(card_count > 0),
    PRIMARY KEY(contact_id,member_id)
);
CREATE INDEX encounters_member ON encounters(member_id,last_at DESC,contact_id DESC);
CREATE TABLE tags (
    id text PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    owner_member_id text REFERENCES members(sub)
);
CREATE UNIQUE INDEX tags_shared_name ON tags(name) WHERE owner_member_id IS NULL;
CREATE UNIQUE INDEX tags_owned_name ON tags(owner_member_id,name) WHERE owner_member_id IS NOT NULL;
CREATE TABLE contact_tags (
    contact_id text NOT NULL REFERENCES contacts(id),
    tag_id text NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(contact_id,tag_id)
);
CREATE TABLE contact_changes (
    id text PRIMARY KEY,
    contact_id text NOT NULL REFERENCES contacts(id),
    actor_member_id text NOT NULL REFERENCES members(sub),
    at timestamptz NOT NULL DEFAULT now(),
    diff jsonb NOT NULL
);
CREATE INDEX contact_changes_contact ON contact_changes(contact_id,at DESC,id DESC);
