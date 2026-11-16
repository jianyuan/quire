// Command quire serves a directory of Markdown files in the Quire reader.
// The reader is a single-page app that Vite builds from web/ into web/dist.
// The binary embeds it, so it needs nothing else at runtime.
//
//	make build                        # build the web app, then the binary
//
//	go run .                          # serve the current directory on http://127.0.0.1:8080
//	go run . ~/docs                   # serve another directory
//	go run . -addr :3000 ~/notes      # listen on every interface, port 3000
//
// Routes:
//
//	GET /api/tree   JSON list of Markdown files under the directory
//	GET /raw/{path} a file from the directory (Markdown, images, PDFs...)
//	GET /assets/... the reader's hashed scripts, styles and fonts
//	GET /licenses   licences of everything bundled into the binary
//	GET /...        the reader, which routes on the path client-side
package main

//go:generate pnpm --dir web install --frozen-lockfile
//go:generate pnpm --dir web build

import (
	"bytes"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed all:web/dist
var dist embed.FS

//go:embed THIRD_PARTY_NOTICES.md
var notices []byte

var skipDirs = map[string]bool{"node_modules": true, "vendor": true}

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "address to listen on")
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: quire [-addr host:port] [directory]\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	dir := "."
	if flag.NArg() > 0 {
		dir = flag.Arg(0)
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		log.Fatal(err)
	}
	// os.Root confines every file access to the directory, so paths like
	// /raw/../../etc/passwd can't escape it.
	root, err := os.OpenRoot(abs)
	if err != nil {
		log.Fatal(err)
	}
	fsys := root.FS()

	web, err := fs.Sub(dist, "web/dist")
	if err != nil {
		log.Fatal(err)
	}
	page, err := fs.ReadFile(web, "index.html")
	if err != nil {
		log.Fatal("web/dist/index.html is missing; run make build: ", err)
	}
	webLicenses, err := fs.ReadFile(web, "licenses.md")
	if err != nil {
		log.Fatal("web/dist/licenses.md is missing; run make build: ", err)
	}
	licenses := append(append(notices, '\n'), webLicenses...)

	started := time.Now()
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/tree", func(w http.ResponseWriter, r *http.Request) {
		files, err := markdownFiles(fsys)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"name": filepath.Base(abs), "files": files})
	})

	mux.HandleFunc("GET /raw/{path...}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("path")
		if !fs.ValidPath(name) || hidden(name) {
			http.NotFound(w, r)
			return
		}
		if info, err := fs.Stat(fsys, name); err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if isMarkdown(name) {
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFileFS(w, r, fsys, name)
	})

	// Vite puts a hash in each asset's name, so browsers can cache them
	// for a year.
	mux.HandleFunc("GET /assets/", func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(web, strings.TrimPrefix(r.URL.Path, "/")); err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.FileServerFS(web).ServeHTTP(w, r)
	})

	mux.HandleFunc("GET /licenses", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, "licenses.txt", started, bytes.NewReader(licenses))
	})

	// Every other path is a page in the reader, which works out what to show.
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		http.ServeContent(w, r, "index.html", started, bytes.NewReader(page))
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("Reading %s on http://%s", abs, *addr)
	log.Fatal(srv.ListenAndServe())
}

// markdownFiles lists every Markdown file under fsys. It skips hidden
// files and folders (.git, .obsidian) and dependency folders.
func markdownFiles(fsys fs.FS) ([]string, error) {
	var files []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if p == "." {
			return nil
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") || skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasPrefix(d.Name(), ".") && isMarkdown(p) {
			files = append(files, p)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

func isMarkdown(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".md", ".markdown", ".mdown":
		return true
	}
	return false
}

func hidden(name string) bool {
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}
