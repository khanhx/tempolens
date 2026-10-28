# Tempolens build targets. go.mod requires Go 1.26; GOTOOLCHAIN=auto lets an
# older local go download and use it.
export GOTOOLCHAIN := auto

VERSION ?= dev
BIN     := bin/tempolens
UI_DIST := internal/ui/dist

# make dev serves on 8234 with auth disabled and role read.
# For write access: TEMPOLENS_AUTH_DISABLED_ROLE=write make dev
# If 8234 is taken by another local run, use DEV_PORT=8235.
TEMPOLENS_AUTH_DISABLED_ROLE ?= read
DEV_PORT ?= 8234

IMAGE ?= tempolens:local

.PHONY: build test lint web embed dev image compose-up compose-down

build:
	go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o $(BIN) ./cmd/tempolens

test:
	go test -p 3 ./...

# gofmt must come from the Go 1.26 toolchain, not an older gofmt on PATH.
lint:
	@out="$$($$(go env GOROOT)/bin/gofmt -l .)"; \
	if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	go vet ./...

web:
	cd web && npm ci && npm run build

# Copy the web build into the go:embed directory, keeping the placeholder.
embed:
	@test -d web/dist || { echo "web/dist missing: run make web first"; exit 1; }
	find $(UI_DIST) -mindepth 1 ! -name PLACEHOLDER.txt -exec rm -rf {} +
	cp -R web/dist/. $(UI_DIST)/
	rm -rf $(UI_DIST)/.vite

dev:
	TEMPOLENS_AUTH_DISABLED=true \
	TEMPOLENS_AUTH_DISABLED_ROLE=$(TEMPOLENS_AUTH_DISABLED_ROLE) \
	TEMPOLENS_PORT=$(DEV_PORT) \
	TEMPOLENS_PUBLIC_ORIGIN=http://localhost:$(DEV_PORT) \
	go run ./cmd/tempolens serve

# Docker builds are heavy; run one at a time.
image:
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE) .

# Local-dev compose: 127.0.0.1:8234, auth disabled, role read.
compose-up:
	docker compose up -d --build

compose-down:
	docker compose down --remove-orphans
