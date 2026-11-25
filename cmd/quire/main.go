// Command quire serves a directory of Markdown files in the Quire reader.
// The reader is a single-page app that Vite builds from web/ into web/dist.
// The quire package at the repository root embeds it, so the binary needs
// nothing else at runtime.
//
//	go install github.com/jianyuan/quire/cmd/quire@latest
//
//	quire                             # serve the current directory on http://127.0.0.1:8080
//	quire ~/docs                      # serve another directory
//	quire -port 3000 ~/notes          # listen on port 3000
//	quire -host 0.0.0.0 ~/notes       # listen on every interface
//	quire help                        # show usage
//
// Routes:
//
//	GET /api/tree   JSON list of Markdown files under the directory
//	GET /api/texts  JSON map of each Markdown file's path to its contents
//	GET /raw/{path} a file from the directory (Markdown, images, PDFs...)
//	GET /assets/... the reader's hashed scripts, styles and fonts
//	GET /licenses   licences of everything bundled into the binary
//	GET /...        the reader, which routes on the path client-side
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jianyuan/quire"
)

var skipDirs = map[string]bool{"node_modules": true, "vendor": true}

func main() {
	host := flag.String("host", "127.0.0.1", "host or interface to listen on")
	port := flag.Int("port", 8080, "port to listen on")
	addr := flag.String("addr", "", "host:port to listen on (overrides -host and -port)")
	flag.Usage = usage
	if len(os.Args) > 1 && os.Args[1] == "help" {
		os.Args[1] = "-h"
	}
	flag.Parse()
	if *addr == "" {
		*addr = net.JoinHostPort(*host, strconv.Itoa(*port))
	}

	dir := "."
	if flag.NArg() > 0 {
		dir = flag.Arg(0)
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		fatal(err)
	}
	// os.Root confines every file access to the directory, so paths like
	// /raw/../../etc/passwd can't escape it.
	root, err := os.OpenRoot(abs)
	if err != nil {
		fatal(err)
	}
	fsys := root.FS()

	web, err := fs.Sub(quire.Dist, "web/dist")
	if err != nil {
		fatal(err)
	}
	page, err := fs.ReadFile(web, "index.html")
	if err != nil {
		fatal(fmt.Errorf("web/dist/index.html is missing; run make build: %w", err))
	}
	webLicenses, err := fs.ReadFile(web, "licenses.md")
	if err != nil {
		fatal(fmt.Errorf("web/dist/licenses.md is missing; run make build: %w", err))
	}
	licenses := slices.Concat(quire.Notices, []byte{'\n'}, webLicenses)

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

	// The reader searches file contents itself, so it fetches them all at once.
	mux.HandleFunc("GET /api/texts", func(w http.ResponseWriter, r *http.Request) {
		files, err := markdownFiles(fsys)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		texts := make(map[string]string, len(files))
		for _, f := range files {
			if b, err := fs.ReadFile(fsys, f); err == nil {
				texts[f] = string(b)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(texts)
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
	// Listen first so a busy port fails with a clear message before the banner.
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		fatal(err)
	}
	fmt.Printf("\n  %s  %s\n\n  %s  %s\n  %s  %s\n\n  %s\n\n",
		paint("1;35", "quire"), paint("2", "ready"),
		paint("36", "Reading"), paint("1", abs),
		paint("36", "Local  "), paint("4;32", "http://"+ln.Addr().String()),
		paint("2", "Press Ctrl+C to stop"))
	fatal(srv.Serve(ln))
}

// paint wraps s in an ANSI style, unless stdout isn't a terminal or NO_COLOR is set.
func paint(code, s string) string { return style(os.Stdout, code, s) }

func style(f *os.File, code, s string) string {
	if fi, err := f.Stat(); err != nil || fi.Mode()&os.ModeCharDevice == 0 || os.Getenv("NO_COLOR") != "" {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, style(os.Stderr, "1;31", "error:"), err)
	os.Exit(1)
}

func usage() {
	out := flag.CommandLine.Output()
	f, _ := out.(*os.File)
	if f == nil {
		f = os.Stderr
	}
	c := func(code, s string) string { return style(f, code, s) }
	fmt.Fprintf(out, "%s  serve a folder of Markdown files in the Quire reader\n\n", c("1;35", "quire"))
	fmt.Fprintf(out, "%s\n  quire [options] [directory]\n  quire help\n\n%s\n", c("1;33", "Usage"), c("1;33", "Options"))
	flag.VisitAll(func(fl *flag.Flag) {
		fmt.Fprintf(out, "  %s  %s %s\n", c("36", fmt.Sprintf("-%-5s", fl.Name)), fl.Usage, c("2", "(default "+strconv.Quote(fl.DefValue)+")"))
	})
	fmt.Fprintf(out, "\n%s\n  quire ~/docs\n  quire -port 3000 ~/notes\n  quire -host 0.0.0.0 .\n", c("1;33", "Examples"))
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
	for part := range strings.SplitSeq(name, "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}
