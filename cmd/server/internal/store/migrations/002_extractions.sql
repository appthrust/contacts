-- Automatic registration: immutable extractions, registration decision, settings.
CREATE TABLE extractions (
    id text PRIMARY KEY,
    card_id text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    engine text NOT NULL,
    model text NOT NULL DEFAULT '',
    fields jsonb NOT NULL,
    field_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    overall double precision NOT NULL,
    duration_ms bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extractions_card ON extractions(card_id, created_at DESC);

ALTER TABLE cards DROP COLUMN ocr_fields;
ALTER TABLE cards
    ADD COLUMN extraction_id text REFERENCES extractions(id),
    ADD COLUMN decision text CHECK (decision IN ('AutoCreated','AutoLinked','NeedsReview','Unavailable')),
    ADD COLUMN decision_reason text;
CREATE INDEX cards_review ON cards(owner_member_id, created_at DESC) WHERE decision = 'NeedsReview';

ALTER TABLE contacts
    ADD COLUMN registered_by text NOT NULL DEFAULT 'member' CHECK (registered_by IN ('member','auto'));
ALTER TABLE contact_changes
    ADD COLUMN source text NOT NULL DEFAULT 'member' CHECK (source IN ('member','auto'));

CREATE TABLE settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    document jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text REFERENCES members(sub)
);
