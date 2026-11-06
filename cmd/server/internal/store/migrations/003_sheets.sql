-- Sheet split: one uploaded image that yielded several cards.
CREATE TABLE sheets (
    id text PRIMARY KEY,
    owner_member_id text NOT NULL REFERENCES members(sub),
    image bytea NOT NULL,
    image_content_type text NOT NULL,
    detected int NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cards
    ADD COLUMN sheet_id text REFERENCES sheets(id),
    ADD COLUMN bbox int[] CHECK (bbox IS NULL OR array_length(bbox, 1) = 4);
CREATE INDEX cards_sheet ON cards(sheet_id);
