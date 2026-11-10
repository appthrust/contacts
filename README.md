# Contacts

Contacts is AppThrust's business-card scanning and shared contacts app. Scan cards,
let the app register confident reads (or review uncertain ones), and see who in the
team already knows a person. The Go server in `cmd/server` serves the React SPA,
`/api/contacts/v1/*`, `/config`, and `/launcher` from one origin behind the OIDC
edge. The SPA uses the session cookie and never handles tokens. PostgreSQL stores
application data; Directory provides member profiles and AI Gateway provides OCR.

The app is released independently of the platform. Source was imported from
`appthrust/platform` commit `27347914ee15817f27a42055160b42506edc73e6`, paths
`cmd/contacts-server` and `dashboard/packages/contacts`.
The original design and API contract are in
[the Contacts design](https://github.com/appthrust/platform/tree/main/design/platform/builtin-app-contacts)
(`README.md`, `auto-registration.md`, and `sheet-split.md`).

## Screens

| Path | Screen |
| --- | --- |
| `/` (`?card=<id>`) | Scan: drop zone or camera picker, grouped multi-card sheets, per-card OCR status, automatic registration with undo, and review with the original sheet. Reading cards poll every 3 seconds. |
| `/contacts` (`?q&company&tag&known=me`) | Search and filters, grouped by company, and "met by N". |
| `/contacts/<id>` | Contact header, automatic-registration badge, card gallery, encounters with Directory links, editing with `If-Match`, tags, history, admin merge, and archive. |
| `/companies`, `/companies/<id>` | Companies and their contacts, editing, and admin merge. |
| `/duplicates` | Proposed duplicate pairs with a choice of which contact to keep. |
| `/settings` | OCR engine and image locality, admin-selectable OCR model, registration policy, thresholds, required fields, privacy defaults, CSV export, and counts. |

## Develop

Use Go 1.26 or newer and Bun 1.4.1. The public Go SDK is
[`github.com/appthrust/appserver-go`](https://github.com/appthrust/appserver-go)
`v0.2.0`; there are no platform module dependencies or local replacements.

```sh
go build ./... && go test ./...
go vet ./...
cd web
export NODE_AUTH_TOKEN="$(gh auth token)"
bun install --frozen-lockfile
bun run typecheck
bun run build:image
```

The two shared npm packages, `@appthrust/app-launcher` and
`@appthrust/platform-dashboard-i18n`, use the published `^0.1.0` versions from
GitHub Packages. `web/.npmrc` reads `NODE_AUTH_TOKEN`; use a token with package read
access. The registry-resolved `web/bun.lock` is committed. The Tailwind source scan
includes the installed launcher package so its styles are bundled.

Run these in separate terminals from `web/`:

```sh
bun run mock   # in-memory API on 127.0.0.1:5246 (CONTACTS_MOCK_PORT)
bun run dev    # Vite on :5248 (CONTACTS_PORT), proxies /api, /config, /launcher
```

Against a real server instead of the mock, set `CONTACTS_API_UPSTREAM=<origin>` and
either `CONTACTS_DEV_BEARER=<token>` for a local Go server or
`CONTACTS_DEV_COOKIE_FILE=<file>` holding the Cookie header of an authenticated
browser session. From the repository root, run the server with:

```sh
go run ./cmd/server --static-dir web/dist
```

Configure `PLATFORM_API_URL`, `PLATFORM_PROJECT_ID`, the `PLATFORM_*` identity
settings, and `CONTACTS_DATABASE_URL` (or `DATABASE_URL`) for a real integration.
`CONTACTS_DIRECTORY_URL` and `CONTACTS_DIRECTORY_PUBLIC_URL` configure Directory;
`CONTACTS_LLM_URL` and optional `CONTACTS_LLM_MODEL` configure OCR through AI
Gateway. `CONTACTS_PUBLIC_URL` must be an HTTPS origin. The listen default is
`:8080`; `--static-dir` or `CONTACTS_STATIC_DIR` overrides `/srv/contacts`.

The image remains `gcr.io/distroless/static:nonroot`, runs as user `65532`, exposes
`8080`, serves the SPA from `/srv/contacts`, and starts `/contacts-server`.
OCR is a Go client of AI Gateway, not a dependency on a native OCR executable.
One card is read at a time. A read may take up to 330 seconds, just above the 300
seconds AI Gateway and the in-Project model servers allow one completion, so a
CPU-only model such as `llm` (`gemma3:4b`, about 160 seconds per card on 2 CPUs)
finishes instead of failing with `context deadline exceeded`. Cards uploaded
meanwhile stay `pending` and are read in order.

### Mock behavior

The mock (`web/src/dev/mock-contacts.ts`, fixtures in `mock-fixtures.ts`) seeds
three members (山田 admin and caller, 佐藤, and 鈴木 without a Directory person),
four companies, twelve contacts with two duplicate pairs, two private contacts,
one draft, two automatically registered contacts, and one low-confidence review.

OCR is fake only in this development mock: uploads stay pending for
`MOCK_OCR_DELAY_MS` (default 2000), then read the next of three canned cards and
register according to the project's `GET`/`PUT /settings` policy. With defaults,
a new person read at 0.92 is AutoCreated, 伊藤 さくら with a known email is
AutoLinked, and a 0.45 read waits for review. `POST /cards/{id}/unlink` undoes a
registration. The mock gateway offers `gemma3:4b` (appthrust, in-cluster),
`gpt-5-mini` (openai, external), and `qwen3-vl-4b-instruct-fp8` (vision, in-cluster).
Changing the model changes the next read and locality notice, not the release
default (`gemma3:4b`).

An upload whose filename contains `sheet` is split into 3–6 cards: a digit 3–6
selects the count, otherwise it is `3 + size mod 4`. Each card is an SVG drawing
of a different person; the third is read at 0.48 and waits for review. The sheet
image is owner/admin-only and is removed with its last card. Set `MOCK_ROLE` to
anything other than `Admin` for a plain member, or `MOCK_OCR=off` for unavailable
OCR and no sheet splitting.

`GET /api/contacts/v1/openapi.json` reads the server's committed document at
`cmd/server/internal/api/openapi.json` unchanged. The existing mock contract test
checks that every documented operation is handled.

| Request | Effect |
| --- | --- |
| `POST /api/contacts/v1/__mock/reset` | Reseed. |
| `POST /api/contacts/v1/__mock/caller` `{memberId, admin?}` | Switch the signed-in member. |
| `POST /api/contacts/v1/__mock/ocr` `{available?, delayMs?, failNext?, model?, local?}` | Configure availability, delay, next failure, reported model, and locality. |

### Checks and local image

```sh
go build ./... && go test ./...
go vet ./...
bun test hack/
(cd web && bun install --frozen-lockfile && bun run build:image)
(cd web && bun run typecheck && bun run test)
NODE_AUTH_TOKEN="$(gh auth token)" docker build --platform linux/amd64 \
  --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t contacts-local .
```

PostgreSQL integration tests skip unless `BUILTIN_APPSERVER_TEST_DATABASE_URL` or
`BUILDER_CONSOLE_TEST_DATABASE_URL` supplies a test database that allows isolated
schema creation. Publisher tests use mocked HTTP and no live service.

## Catalog and release

`catalog/entry.yaml` preserves the complete specification and every served version
from the read-only `appthrust-ink-pmc001` Contacts ApplicationStackDefinition. Its
compatibility floor is `0.1.0`, retaining the original immutable
`ghcr.io/appthrust/platform/contacts@sha256:ee76d16fc359a16fc46be2e5f08e1b94c0dfe3b6f2ca624154158dd301e76002`
image. The next release is **`0.2.0`**, stream **`0.2`**. No placeholder image for
that release is committed.

When a release is authorized, push a `v<semver>` tag. The publisher workflow:

1. Builds Linux amd64 and arm64 together with one `docker buildx build` invocation
   on `ubuntu-24.04`, pushes `ghcr.io/appthrust/contacts:<semver>`, resolves the
   immutable image-index digest, and signs it with Cosign keyless signing.
2. Reads the existing Cloud catalog entry and merges its version history with the
   committed floor. New versions use `ghcr.io/appthrust/contacts@sha256:<digest>`;
   only the new version is default and previous versions remain served. Images
   are immutable: an existing version cannot be assigned a different digest.
3. PUTs `/api/v1/catalog/entries/contacts` and POSTs `/api/v1/catalog/publish`.
   HTTP 202 `{id, state: "queued"}` means Cloud dispatched publication; HTTP 200
   `{id, state: "snapshot"}` causes the workflow to mint a Cloud-scoped GitHub App
   token and dispatch `catalog-publish` with the snapshot ID.
4. Waits up to 10 minutes for the signed catalog artifact to contain the exact
   Contacts version and digest. It verifies the index digest and the Cloud
   catalog-publish workflow signature; dispatch alone is not success.

The workflow is guarded to `appthrust/contacts` and serialized by
`contacts-catalog-publish`. It needs repository secret `CLOUD_CATALOG_ADMIN_TOKEN`,
variable `CLOUD_API_URL` (default `https://api.appthrust.com`), and organization
secrets `APPTHRUST_GITHUB_ACTIONS_APP_ID` and
`APPTHRUST_GITHUB_ACTIONS_APP_PRIVATE_KEY`. The GitHub App must be installed for
`appthrust/cloud` with repository dispatch permission. GitHub Packages must grant
this repository read access to the shared npm packages. `GITHUB_TOKEN` enters the
Docker build only as the `NODE_AUTH_TOKEN` BuildKit secret. The GHCR image package
must be public after the first release.

The publisher CLI is:

```sh
bun hack/publish-entry.ts submit --version 0.2.0 --digest sha256:<image-index-digest>
bun hack/publish-entry.ts await --version 0.2.0 --digest sha256:<image-index-digest>
```

`await` uses ORAS and Cosign; it needs no Cloud admin token. Existing installations
must explicitly update to the new version with `replaceRepository: true` to
switch away from `ghcr.io/appthrust/platform/contacts`. Afterwards `follow` tracks
the selected stream. `/releasez` reports catalog-rendered
`CONTACTS_RELEASE_VERSION` and `CONTACTS_ARTIFACT_DIGEST`.

Migration authority:
[First-party app repositories](https://github.com/appthrust/platform/blob/main/design/platform/marketplace-apps/first-party-app-repositories.md),
sections **App repository** and **Migration**.
