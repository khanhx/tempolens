package ui

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

const (
	cacheImmutable = "public, max-age=31536000, immutable"
	cacheNoCache   = "no-cache"
)

// notBuilt is served when only the placeholder is embedded. It has no inline
// script or style, so it passes the CSP.
var notBuilt = []byte(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tempolens</title></head>
<body><h1>Tempolens</h1><p>The web UI is not built into this binary. Run <code>make web embed</code> and rebuild. The API is available under <code>/api/v1</code>.</p></body></html>
`)

type file struct {
	body  []byte
	gz    []byte
	ctype string
}

// Handler serves the SPA from memory. Files are read once at startup; request
// paths are only used as map keys, never to open files.
type Handler struct {
	files map[string]*file
	index *file
}

// New loads every file of fsys and pre-gzips the compressible ones.
func New(fsys fs.FS) (*Handler, error) {
	h := &Handler{files: map[string]*file{}}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || p == "PLACEHOLDER.txt" {
			return err
		}
		body, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		f := &file{body: body, ctype: contentType(p)}
		if compressible(p) {
			if f.gz, err = gzipBytes(body); err != nil {
				return err
			}
		}
		h.files["/"+p] = f
		return nil
	})
	if err != nil {
		return nil, err
	}
	if idx, ok := h.files["/index.html"]; ok {
		h.index = idx
	} else {
		h.index = &file{body: notBuilt, ctype: "text/html; charset=utf-8"}
	}
	return h, nil
}

// ServeHTTP serves /assets/* as immutable files (404 when missing), other
// existing files with no-cache, and index.html for every other path.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if strings.HasPrefix(p, "/assets/") {
		f, ok := h.files[p]
		if !ok {
			http.NotFound(w, r)
			return
		}
		serve(w, r, f, cacheImmutable)
		return
	}
	if f, ok := h.files[p]; ok && p != "/index.html" {
		serve(w, r, f, cacheNoCache)
		return
	}
	serve(w, r, h.index, cacheNoCache)
}

func serve(w http.ResponseWriter, r *http.Request, f *file, cache string) {
	hdr := w.Header()
	hdr.Set("Content-Type", f.ctype)
	hdr.Set("Cache-Control", cache)
	body := f.body
	if f.gz != nil {
		hdr.Add("Vary", "Accept-Encoding")
		if acceptsGzip(r) {
			hdr.Set("Content-Encoding", "gzip")
			body = f.gz
		}
	}
	hdr.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		enc, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(enc), "gzip") && strings.ReplaceAll(params, " ", "") != "q=0" {
			return true
		}
	}
	return false
}

func compressible(p string) bool {
	switch path.Ext(p) {
	case ".js", ".css", ".svg", ".html", ".json", ".map", ".txt":
		return true
	}
	return false
}

func contentType(p string) string {
	if t := mime.TypeByExtension(path.Ext(p)); t != "" {
		return t
	}
	return "application/octet-stream"
}

func gzipBytes(b []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(b); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
