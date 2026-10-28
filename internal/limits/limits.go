// Package limits holds the in-memory per-principal limiters: a token bucket
// for request rate and a counter for concurrent streams.
package limits

import (
	"math"
	"sync"
	"time"
)

// Streams caps concurrent long-lived requests (history long-polls and
// exports) per principal.
type Streams struct {
	mu     sync.Mutex
	max    int
	active map[string]int
}

// NewStreams returns a limiter allowing max concurrent streams per key.
func NewStreams(max int) *Streams {
	return &Streams{max: max, active: map[string]int{}}
}

// Acquire takes a stream slot for key. When ok is true, release must be
// called exactly once when the stream ends.
func (s *Streams) Acquire(key string) (release func(), ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[key] >= s.max {
		return nil, false
	}
	s.active[key]++
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.active[key]--; s.active[key] <= 0 {
				delete(s.active, key)
			}
		})
	}, true
}

// Rate is a per-key token bucket limiter.
type Rate struct {
	mu      sync.Mutex
	rps     float64
	burst   float64
	buckets map[string]*bucket
	now     func() time.Time
	lastGC  time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// idleTTL is how long an untouched bucket is kept; a full bucket after that
// is equivalent to a new one.
const idleTTL = 10 * time.Minute

// NewRate returns a limiter refilling rps tokens per second up to burst.
func NewRate(rps float64, burst int) *Rate {
	return &Rate{rps: rps, burst: float64(burst), buckets: map[string]*bucket{}, now: time.Now}
}

// Allow takes one token for key. When none is available it returns false
// and the wait until the next token.
func (r *Rate) Allow(key string) (ok bool, retryAfter time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if now.Sub(r.lastGC) > idleTTL {
		for k, b := range r.buckets {
			if now.Sub(b.last) > idleTTL {
				delete(r.buckets, k)
			}
		}
		r.lastGC = now
	}
	b, found := r.buckets[key]
	if !found {
		b = &bucket{tokens: r.burst, last: now}
		r.buckets[key] = b
	}
	b.tokens = math.Min(r.burst, b.tokens+now.Sub(b.last).Seconds()*r.rps)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) / r.rps * float64(time.Second))
}
