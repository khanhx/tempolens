package xapi

import (
	"net/http"

	"tempolens/internal/auth"
	"tempolens/internal/authz"
	"tempolens/internal/config"
)

type meUser struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

type meCodec struct {
	Endpoint            string `json:"endpoint"`
	IncludeCredentials  bool   `json:"includeCredentials"`
	DefaultErrorMessage string `json:"defaultErrorMessage"`
	DefaultErrorLink    string `json:"defaultErrorLink"`
}

type meLimits struct {
	ScanMaxWorkflows    int `json:"scanMaxWorkflows"`
	FanoutMaxNamespaces int `json:"fanoutMaxNamespaces"`
	PageSizeMax         int `json:"pageSizeMax"`
	GraphDepthMax       int `json:"graphDepthMax"`
}

type meSettings struct {
	DefaultNamespace    string   `json:"defaultNamespace"`
	ShowSystemNamespace bool     `json:"showSystemNamespace"`
	DisabledActions     []string `json:"disabledActions"`
	ProtectedNamespaces []string `json:"protectedNamespaces"`
	Codec               meCodec  `json:"codec"`
	Limits              meLimits `json:"limits"`
	Version             string   `json:"version"`
}

type meResponse struct {
	User        *meUser    `json:"user"`
	Role        string     `json:"role"`
	AuthEnabled bool       `json:"authEnabled"`
	Settings    meSettings `json:"settings"`
}

// me describes the caller and the UI settings. The role is the effective
// role after re-checking groups, and disabledActions mirrors what the
// interceptor enforces.
func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	resp := meResponse{
		Role:        string(p.Role),
		AuthEnabled: !h.cfg.Auth.Disabled,
		Settings: meSettings{
			DefaultNamespace:    h.cfg.DefaultNamespace,
			ShowSystemNamespace: h.cfg.ShowSystemNamespace,
			DisabledActions:     h.disabledActions(p),
			ProtectedNamespaces: h.policy.ProtectedNamespaces(),
			Codec: meCodec{
				Endpoint:            h.cfg.Codec.Endpoint,
				IncludeCredentials:  h.cfg.Codec.IncludeCredentials,
				DefaultErrorMessage: h.cfg.Codec.DefaultErrorMessage,
				DefaultErrorLink:    h.cfg.Codec.DefaultErrorLink,
			},
			Limits: meLimits{
				ScanMaxWorkflows:    h.cfg.Limits.ScanMaxWorkflows,
				FanoutMaxNamespaces: h.cfg.Limits.FanoutMaxNamespaces,
				PageSizeMax:         pageSizeMax,
				GraphDepthMax:       graphDepthMax,
			},
			Version: h.version,
		},
	}
	if !p.Local && !p.Internal {
		resp.User = &meUser{Sub: p.Sub, Email: p.Email, Name: p.Name}
	}
	writeJSON(w, resp)
}

func (h *Handler) disabledActions(p *auth.Principal) []string {
	actions := h.policy.DisabledByEnv()
	switch {
	case p.Role == config.RoleRead || h.cfg.DisableWriteActions:
		actions = authz.AllActions
	case p.Role == config.RoleWrite:
		// Write users may not perform the admin-only actions; keep AllActions order.
		hidden := map[authz.Action]bool{}
		for _, a := range append(actions, authz.AdminActions...) {
			hidden[a] = true
		}
		actions = nil
		for _, a := range authz.AllActions {
			if hidden[a] {
				actions = append(actions, a)
			}
		}
	}
	out := make([]string, 0, len(actions))
	for _, a := range actions {
		out = append(out, string(a))
	}
	return out
}
