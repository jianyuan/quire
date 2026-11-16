# Quire

Quire is a reader for folders of Markdown files. Point it at a folder and it serves the files as a website you can browse and read on your own machine. It ships as a single binary with nothing else to install.

I built it to read my notes and project docs with proper typography, without setting up a static site generator.

## What it does

- Lists every Markdown file in the folder in a sidebar. It skips hidden folders such as `.git` and dependency folders such as `node_modules`.
- Opens `README.md` or `index.md` when you visit a folder.
- Shows a table of contents, reading time and links to the previous and next files.
- Marks links to files that don't exist.
- Has four themes (auto, paper, sepia and ink) and three fonts. The browser remembers your choices.
- Works offline. The fonts and scripts are built into the binary.

Keyboard shortcuts:

| Key | Action |
|---|---|
| `/` | Find a file |
| `[` | Show or hide the sidebar |
| `+` and `-` | Change the text size |
| `t` | Switch theme |
| `Esc` | Close menus |

## Run it

You need [Go](https://go.dev) 1.27 or later.

```sh
go run .                          # read this folder on http://127.0.0.1:8080
go run . ~/notes                  # read another folder
go run . -addr :3000 ~/notes      # listen on port 3000 on every network interface
```

Quire only reads files inside the folder you give it. It listens on `127.0.0.1` by default, so other machines can't reach it. Use `-addr` with care, because anyone who can reach the port can read the files in the folder.

## Build it

`make` on its own lists every target. The main ones:

```sh
make build    # build bin/quire for this machine
make dist     # build binaries for macOS, Linux and Windows into dist/
make run      # build, then serve DIR on ADDR (make run DIR=~/notes)
```

The binaries are about 7 MB each and have no other dependencies.

## Change the web app

The reader's page is a [Vite](https://vite.dev) app in `web/`, styled with Tailwind CSS and daisyUI. The Go server embeds the built files from `web/dist`. That folder is committed, so `go run` works without Node.js.

To work on the page you need Node.js and [pnpm](https://pnpm.io):

```sh
make install    # install the web app's packages
make dev        # run Vite and the Go server together, with live reload
make web        # rebuild web/dist
```

After changing anything in `web/`, run `make web` and commit `web/dist` with your change. `make check-web` fails if `web/dist` is out of date, so you can run it in CI.

## Licences

Quire bundles fonts and libraries under the MIT, Apache 2.0 and SIL Open Font licences. The binary serves the full text of each at `/licenses`, and there's a link at the bottom of the sidebar. The Go licence is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Quire itself is under the [MIT licence](LICENSE).
