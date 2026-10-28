package xapi

import (
	"bytes"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestUserQuery(t *testing.T) {
	for q, ok := range map[string]bool{
		``: true,
		`WorkflowType = "a" AND (x = 1 OR y = 2)`: true,
		`WorkflowId = 'order by me'`:              true,
		`WorkflowId = "a(b" AND x = ')'`:          true,
		`WorkflowId = "say \"hi\" (x"`:            true,
		"`Custom Attr` = 'x'":                     true,
		`WorkflowType = "a" ORDER BY StartTime`:   false,
		`x = 1 order  by y`:                       false,
		"x = 1 Order\nBy y":                       false,
		`a) OR (b`:                                false,
		`(a`:                                      false,
		`WorkflowId = "abc`:                       false,
		`WorkflowId = 'abc`:                       false,
	} {
		r := httptest.NewRequest("GET", "/api/x/workflows?query="+url.QueryEscape(q), nil)
		_, err := userQuery(r)
		if (err == nil) != ok {
			t.Errorf("userQuery(%q): err=%v, want ok=%v", q, err, ok)
		}
	}
}

func TestWithClause(t *testing.T) {
	for _, tc := range []struct{ q, want string }{
		{"a OR b", `(a OR b) AND ExecutionStatus="Running"`},
		{"", `ExecutionStatus="Running"`},
		{"  ", `ExecutionStatus="Running"`},
	} {
		if got := withClause(tc.q, `ExecutionStatus="Running"`); got != tc.want {
			t.Errorf("withClause(%q) = %q, want %q", tc.q, got, tc.want)
		}
	}
	if got := withGroupBy("a OR b"); got != "(a OR b) GROUP BY ExecutionStatus" {
		t.Errorf("withGroupBy = %q", got)
	}
	if got := withGroupBy(""); got != "GROUP BY ExecutionStatus" {
		t.Errorf("withGroupBy empty = %q", got)
	}
	if got := quote(`a"b\c`); got != `"a\"b\\c"` {
		t.Errorf("quote = %s", got)
	}
}

func TestCompareKeys(t *testing.T) {
	c := func(v int64) *int64 { return &v }
	running := sortKey{Start: 5, Run: "a"}
	closedLate := sortKey{Close: c(100), Start: 1, Run: "b"}
	closedEarly := sortKey{Close: c(50), Start: 9, Run: "c"}
	sameCloseLaterStart := sortKey{Close: c(50), Start: 10, Run: "z"}
	sameAllRunA := sortKey{Close: c(50), Start: 9, Run: "a"}

	// Both SQL and Elasticsearch visibility on 1.24 put running rows first.
	order := []sortKey{running, closedLate, sameCloseLaterStart, sameAllRunA, closedEarly}
	for i := 0; i+1 < len(order); i++ {
		if compareKeys(order[i], order[i+1]) >= 0 {
			t.Errorf("%+v must sort before %+v", order[i], order[i+1])
		}
	}
	if compareKeys(closedLate, closedLate) != 0 {
		t.Error("equal keys must compare equal")
	}
}

func TestTokenRejectsForeignNamespace(t *testing.T) {
	h := &Handler{keys: [][]byte{bytes.Repeat([]byte{1}, 32)}}
	tok, err := h.signToken(pageToken{V: 1, Q: "q", NS: map[string]nsCursor{"other": {}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.openToken(tok, "q", []string{"ns-a"}); err == nil {
		t.Fatal("a token naming a namespace outside the selection must be rejected")
	}
	if _, err := h.openToken(tok, "q", []string{"ns-a", "other"}); err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	// Rotation: a token signed with the old key still verifies.
	rotated := &Handler{keys: [][]byte{bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{1}, 32)}}
	if _, err := rotated.openToken(tok, "q", []string{"other"}); err != nil {
		t.Fatalf("token signed before rotation rejected: %v", err)
	}
	other := &Handler{keys: [][]byte{bytes.Repeat([]byte{3}, 32)}}
	if _, err := other.openToken(tok, "q", []string{"other"}); err == nil {
		t.Fatal("token signed with an unrelated key accepted")
	}
}
