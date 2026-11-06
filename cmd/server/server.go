package main

import (
	"encoding/json"
	"errors"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/pending"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/appserver-go/appserver/platformenv"
	"github.com/appthrust/appserver-go/appserver/releaseidentity"
	"github.com/appthrust/contacts/cmd/server/internal/api"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// parseOrigin validates the public URL before applying its HTTPS-only policy.
func parseOrigin(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return nil, errors.New("URL must be an origin without credentials, a path, query, or fragment")
	}
	return u, nil
}

// newHandler mounts the contacts under the SPA. ready gates /readyz only
// (see pending.Probes).
func newHandler(staticDir, upstreamURL, projectID string, contacts http.Handler, ready func() bool) (http.Handler, error) {
	if _, err := platformenv.Validate(upstreamURL, projectID); err != nil {
		return nil, err
	}
	authenticator, err := identity.New(identity.FromEnv("CONTACTS"))
	if err != nil {
		return nil, err
	}
	catalog := launcher.NewCatalog(platformclient.New(upstreamURL, projectID, platformclient.WithHTTPClient(authenticator.HTTPClient())), "contacts")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"projectId": projectID, "publicUrl": os.Getenv("CONTACTS_PUBLIC_URL"), "directoryUrl": os.Getenv("CONTACTS_DIRECTORY_PUBLIC_URL")})
	})
	mux.Handle("GET /launcher", launcher.NewHandler(catalog, authenticator.Authenticate))
	mux.Handle("GET /releasez", releaseidentity.NewHandler("CONTACTS", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("UI release status unavailable\n"))
	}))
	pending.Probes(mux, ready)
	if contacts == nil {
		contacts = api.Unavailable()
	}
	mux.Handle("/api/contacts/", contacts)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveStatic(w, r, staticDir)
	})
	return mux, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func serveStatic(w http.ResponseWriter, r *http.Request, root string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")))
	info, err := os.Stat(name)
	asset := strings.HasPrefix(r.URL.Path, "/assets/")
	if err != nil || !info.Mode().IsRegular() {
		if asset {
			http.NotFound(w, r)
			return
		}
		name = filepath.Join(root, "index.html")
	}
	file, err := os.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if filepath.Base(name) == "index.html" {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	} else if asset {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(w, r, filepath.Base(name), info.ModTime(), file)
}
