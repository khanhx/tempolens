package gateway

import (
	"encoding/json"
	"net/http"

	"tempolens/internal/auth"
	"tempolens/internal/config"
)

// settingsResponse keeps the upstream GET /api/v1/settings shape.
type settingsResponse struct {
	Auth                          settingsAuth
	DefaultNamespace              string
	ShowTemporalSystemNamespace   bool
	NavCollapsedByDefault         bool
	FeedbackURL                   string
	DisableNewsFetch              bool
	Codec                         settingsCodec
	Version                       string
	DisableWriteActions           bool
	WorkflowTerminateDisabled     bool
	WorkflowCancelDisabled        bool
	WorkflowSignalDisabled        bool
	WorkflowUpdateDisabled        bool
	WorkflowResetDisabled         bool
	WorkflowPauseDisabled         bool
	BatchActionsDisabled          bool
	StartWorkflowDisabled         bool
	HideWorkflowQueryErrors       bool
	RefreshWorkflowCountsDisabled bool
	ActivityCommandsDisabled      bool
}

type settingsAuth struct {
	Enabled            bool
	Options            []string
	RedirectToProvider bool
}

type settingsCodec struct {
	Endpoint            string
	PassAccessToken     bool
	IncludeCredentials  bool
	DefaultErrorMessage string
	DefaultErrorLink    string
}

// Settings serves GET /api/v1/settings for the calling principal.
// DisableWriteActions is true for read principals.
func Settings(cfg *config.Config, version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := auth.FromContext(r.Context())
		readOnly := cfg.DisableWriteActions || p == nil || (p.Role != config.RoleWrite && p.Role != config.RoleAdmin)
		d := cfg.Disabled
		body, err := json.Marshal(settingsResponse{
			Auth:                        settingsAuth{Enabled: !cfg.Auth.Disabled, RedirectToProvider: !cfg.Auth.Disabled},
			DefaultNamespace:            cfg.DefaultNamespace,
			ShowTemporalSystemNamespace: cfg.ShowSystemNamespace,
			DisableNewsFetch:            true,
			Codec: settingsCodec{
				Endpoint:            cfg.Codec.Endpoint,
				IncludeCredentials:  cfg.Codec.IncludeCredentials,
				DefaultErrorMessage: cfg.Codec.DefaultErrorMessage,
				DefaultErrorLink:    cfg.Codec.DefaultErrorLink,
			},
			Version:                   version,
			DisableWriteActions:       readOnly,
			WorkflowTerminateDisabled: d.Terminate,
			WorkflowCancelDisabled:    d.Cancel,
			WorkflowSignalDisabled:    d.Signal,
			WorkflowUpdateDisabled:    d.Update,
			WorkflowResetDisabled:     d.Reset,
			WorkflowPauseDisabled:     d.Pause,
			BatchActionsDisabled:      d.Batch,
			StartWorkflowDisabled:     d.Start,
			ActivityCommandsDisabled:  readOnly || d.Activity,
		})
		if err != nil {
			http.Error(w, "settings unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(body)
	}
}
