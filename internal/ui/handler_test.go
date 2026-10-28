package ui

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func get(t *testing.T, h http.Handler, path string, gz bool) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if gz {
		r.Header.Set("Accept-Encoding", "gzip, br")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestHandler(t *testing.T) {
	js := strings.Repeat("export const a = 1;\n", 50)
	h, err := New(fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>Tempolens</title>")},
		"favicon.svg":          {Data: []byte("<svg/>")},
		"assets/index-abc.js":  {Data: []byte(js)},
		"assets/index-abc.css": {Data: []byte("body{}")},
		"assets/logo.png":      {Data: []byte{0x89, 'P', 'N', 'G'}},
		"PLACEHOLDER.txt":      {Data: []byte("x")},
	})
	if err != nil {
		t.Fatal(err)
	}

	w := get(t, h, "/assets/index-abc.js", true)
	if w.Header().Get("Cache-Control") != cacheImmutable || w.Header().Get("Content-Encoding") != "gzip" ||
		!strings.HasPrefix(w.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("js asset headers: %v", w.Header())
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := io.ReadAll(zr); string(b) != js {
		t.Fatal("gzipped body differs")
	}

	if w := get(t, h, "/assets/index-abc.js", false); w.Header().Get("Content-Encoding") != "" || w.Body.String() != js {
		t.Fatal("plain body expected without Accept-Encoding")
	}
	if w := get(t, h, "/assets/logo.png", true); w.Header().Get("Content-Encoding") != "" {
		t.Fatal("png must not be gzipped")
	}
	if w := get(t, h, "/assets/missing.js", false); w.Code != http.StatusNotFound {
		t.Fatalf("missing asset: %d", w.Code)
	}
	if w := get(t, h, "/favicon.svg", false); w.Body.String() != "<svg/>" || w.Header().Get("Cache-Control") != cacheNoCache {
		t.Fatal("root file not served with no-cache")
	}
	for _, p := range []string{"/", "/namespaces/default/workflows", "/index.html", "/PLACEHOLDER.txt", "/../etc/passwd"} {
		w := get(t, h, p, false)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<title>Tempolens</title>") || w.Header().Get("Cache-Control") != cacheNoCache {
			t.Errorf("%s: not the SPA index (status %d)", p, w.Code)
		}
	}

	r := httptest.NewRequest(http.MethodHead, "/", nil)
	hw := httptest.NewRecorder()
	h.ServeHTTP(hw, r)
	if hw.Body.Len() != 0 || hw.Header().Get("Content-Length") == "" {
		t.Fatal("HEAD must send headers only")
	}
}

func TestNotBuilt(t *testing.T) {
	h, err := New(fstest.MapFS{"PLACEHOLDER.txt": {Data: []byte("x")}})
	if err != nil {
		t.Fatal(err)
	}
	w := get(t, h, "/namespaces", false)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "not built") || strings.Contains(w.Body.String(), "<style") {
		t.Fatalf("not-built page: %d %s", w.Code, w.Body.String())
	}
}

func TestEmbeddedPlaceholderLoads(t *testing.T) {
	if _, err := New(Dist()); err != nil {
		t.Fatalf("embedded dist: %v", err)
	}
}
