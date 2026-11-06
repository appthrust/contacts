package api

import (
	"context"
	_ "embed"
	"net/http"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
)

//go:embed openapi.json
var openapiDocument []byte

func (a *API) openapi(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, err := a.authenticate(r.WithContext(ctx)); err != nil {
		httpx.WriteError(w, err, "contacts")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(openapiDocument)
}
