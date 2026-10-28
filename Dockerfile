# syntax=docker/dockerfile:1

# Tempolens image: web build -> static Go binary -> distroless nonroot.
ARG VERSION=0.0.0-dev

# 1. Web: build the SPA and enforce the bundle budget (fails the build when exceeded).
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# The Vite manifest is only needed by the budget check; it is not served.
RUN npm run build && npm run budget && rm -rf dist/.vite

# 2. Server: a static binary with the SPA embedded.
FROM golang:1.26 AS build
ARG VERSION
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY --from=web /src/web/dist/ internal/ui/dist/
RUN go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/tempolens ./cmd/tempolens

# 3. Runtime: no shell; CA certificates and tzdata included; uid 65532.
# Pinned by digest; bump it deliberately when updating the base.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
COPY --from=build /out/tempolens /tempolens
USER nonroot:nonroot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["/tempolens", "healthcheck"]
ENTRYPOINT ["/tempolens"]
