// Package ui serves the embedded single-page app.
package ui

import (
	"embed"
	"io/fs"
)

// The build copies web/dist here (make embed, Dockerfile). A committed
// placeholder keeps the pattern valid without a web build.
//
//go:embed all:dist
var dist embed.FS

// Dist returns the embedded web build rooted at its top directory.
func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		// The pattern above guarantees the directory exists.
		panic(err)
	}
	return sub
}
