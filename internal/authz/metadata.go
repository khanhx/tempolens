package authz

import (
	"context"

	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// MetadataKeys are the only gRPC metadata keys sent to Temporal.
var MetadataKeys = []string{"client-name", "client-version"}

// withOutgoingMetadata replaces all outgoing metadata, which drops anything
// the gateway forwarded (authorization, grpcgateway-*, x-forwarded-*).
func withOutgoingMetadata(ctx context.Context, version string) context.Context {
	return metadata.NewOutgoingContext(ctx, metadata.Pairs("client-name", "tempolens", "client-version", version))
}

// stamp writes value into every string field at paths. A path whose
// intermediate field is an unset oneof member is skipped; other intermediate
// messages are created. It returns how many paths were stamped.
func stamp(m proto.Message, paths []string, value string) int {
	n := 0
	for _, p := range paths {
		if stampPath(m.ProtoReflect(), splitPath(p), value) {
			n++
		}
	}
	return n
}

func stampPath(msg protoreflect.Message, path []string, value string) bool {
	for i, name := range path {
		fd := msg.Descriptor().Fields().ByName(protoreflect.Name(name))
		if fd == nil || fd.Cardinality() == protoreflect.Repeated {
			return false
		}
		if i == len(path)-1 {
			if fd.Kind() != protoreflect.StringKind {
				return false
			}
			msg.Set(fd, protoreflect.ValueOfString(value))
			return true
		}
		if fd.Kind() != protoreflect.MessageKind {
			return false
		}
		if od := fd.ContainingOneof(); od != nil && !od.IsSynthetic() && !msg.Has(fd) {
			return false
		}
		msg = msg.Mutable(fd).Message()
	}
	return false
}

// stringAt reads a string field at a dot path, or "" when absent.
func stringAt(m proto.Message, path string) string {
	msg := m.ProtoReflect()
	parts := splitPath(path)
	for i, name := range parts {
		fd := msg.Descriptor().Fields().ByName(protoreflect.Name(name))
		if fd == nil || fd.Cardinality() == protoreflect.Repeated {
			return ""
		}
		if i == len(parts)-1 {
			if fd.Kind() != protoreflect.StringKind {
				return ""
			}
			return msg.Get(fd).String()
		}
		if fd.Kind() != protoreflect.MessageKind || !msg.Has(fd) {
			return ""
		}
		msg = msg.Get(fd).Message()
	}
	return ""
}

func splitPath(p string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(p); i++ {
		if i == len(p) || p[i] == '.' {
			out = append(out, p[start:i])
			start = i + 1
		}
	}
	return out
}
