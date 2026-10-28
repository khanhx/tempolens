module tempolens

go 1.26.0

require (
	github.com/coreos/go-oidc/v3 v3.21.0
	github.com/go-jose/go-jose/v4 v4.1.4
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.32.0
	go.temporal.io/api v1.64.0
	golang.org/x/oauth2 v0.37.0
	google.golang.org/genproto/googleapis/api v0.0.0-20261012220534-4341edf3f941
	google.golang.org/grpc v1.84.0
	google.golang.org/protobuf v1.36.12
)

require (
	github.com/nexus-rpc/nexus-proto-annotations v0.1.0 // indirect
	golang.org/x/net v0.61.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20261005182115-fad411399dd8 // indirect
)

ignore (
	./test
	./web
)
