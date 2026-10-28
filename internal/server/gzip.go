package server

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

var gzipPool = sync.Pool{New: func() any { return gzip.NewWriter(nil) }}

// gzipJSON compresses JSON responses for clients that accept gzip. Static
// assets are pre-gzipped by the UI handler and the export stream is left
// alone. Flush passes through, so long-polls keep working.
func gzipJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == exportPath || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}

type gzipWriter struct {
	http.ResponseWriter
	gz       *gzip.Writer
	decided  bool
	compress bool
}

func (g *gzipWriter) WriteHeader(code int) {
	if !g.decided {
		g.decided = true
		h := g.Header()
		if code >= 200 && code != http.StatusNoContent && code != http.StatusNotModified &&
			h.Get("Content-Encoding") == "" && strings.HasPrefix(h.Get("Content-Type"), "application/json") {
			g.compress = true
			h.Set("Content-Encoding", "gzip")
			h.Del("Content-Length")
			h.Add("Vary", "Accept-Encoding")
		}
	}
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipWriter) Write(b []byte) (int, error) {
	if !g.decided {
		g.WriteHeader(http.StatusOK)
	}
	if !g.compress {
		return g.ResponseWriter.Write(b)
	}
	if g.gz == nil {
		g.gz = gzipPool.Get().(*gzip.Writer)
		g.gz.Reset(g.ResponseWriter)
	}
	return g.gz.Write(b)
}

func (g *gzipWriter) Flush() {
	if g.gz != nil {
		_ = g.gz.Flush()
	}
	_ = http.NewResponseController(g.ResponseWriter).Flush()
}

func (g *gzipWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

func (g *gzipWriter) close() {
	if g.gz != nil {
		_ = g.gz.Close()
		g.gz.Reset(nil)
		gzipPool.Put(g.gz)
		g.gz = nil
	}
}
