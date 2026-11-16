BIN       := bin/quire
DIR       ?= .
ADDR      ?= 127.0.0.1:8080
PLATFORMS := darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64
GOFLAGS   := -trimpath -ldflags="-s -w"

WEB_SRC := web/index.html web/vite.config.js web/package.json $(shell find web/src -type f)
GO_SRC  := go.mod $(wildcard *.go)

.DEFAULT_GOAL := help

##@ General
help: ## Show this help
	@awk 'BEGIN { FS = ":.*## " } \
	  /^##@ / { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
	  /^[a-zA-Z0-9_.\/-]+:.*## / { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

##@ Development
install: web/node_modules ## Install the web app's dependencies

dev: web/dist/index.html web/node_modules ## Run Vite and the Go server together (DIR=...)
	@trap 'kill 0' EXIT; \
	  go run . -addr $(ADDR) $(DIR) & \
	  pnpm --dir web dev

run: build ## Build, then serve DIR on ADDR
	./$(BIN) -addr $(ADDR) $(DIR)

check: ## Vet and format-check the Go code
	go vet ./...
	@test -z "$$(gofmt -l $(wildcard *.go))" || { gofmt -l $(wildcard *.go); exit 1; }

check-web: web/node_modules ## Fail if the committed web/dist is stale
	pnpm --dir web build
	@test -z "$$(git status --porcelain -- web/dist)" || \
	  { git status --short -- web/dist; echo "web/dist is out of date: run make web and commit it"; exit 1; }

##@ Build
web: web/dist/index.html ## Build the web app into web/dist

build: $(BIN) ## Build the single binary for this machine

dist: web/dist/index.html ## Cross-compile binaries for every platform
	@for p in $(PLATFORMS); do \
	  os=$${p%/*}; arch=$${p#*/}; ext=; [ $$os = windows ] && ext=.exe; \
	  echo "dist/quire-$$os-$$arch$$ext"; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build $(GOFLAGS) -o dist/quire-$$os-$$arch$$ext . || exit 1; \
	done

clean: ## Remove binaries (keeps the committed web/dist)
	rm -rf bin dist

# File targets: each step reruns only when its inputs change.
web/node_modules: web/package.json web/pnpm-lock.yaml
	pnpm --dir web install --frozen-lockfile
	@touch $@

web/dist/index.html: web/node_modules $(WEB_SRC)
	pnpm --dir web build

$(BIN): web/dist/index.html $(GO_SRC)
	CGO_ENABLED=0 go build $(GOFLAGS) -o $@ .

.PHONY: help install dev run check check-web web build dist clean
