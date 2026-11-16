// Package quire holds the files that the quire command (in cmd/quire)
// builds into its binary. They live here because go:embed can't reach
// files above a package's own directory.
package quire

//go:generate pnpm --dir web install --frozen-lockfile
//go:generate pnpm --dir web build

import "embed"

// Dist is the reader app that Vite builds into web/dist. It's committed,
// so go install and go run work without Node.js.
//
//go:embed all:web/dist
var Dist embed.FS

// Notices holds the licence of the Go standard library, which is compiled
// into the binary. The web app's licences are in web/dist/licenses.md.
//
//go:embed THIRD_PARTY_NOTICES.md
var Notices []byte
