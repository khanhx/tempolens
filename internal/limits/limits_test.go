package limits

import (
	"testing"
	"time"
)

func TestStreams(t *testing.T) {
	s := NewStreams(2)
	r1, ok1 := s.Acquire("a")
	_, ok2 := s.Acquire("a")
	_, ok3 := s.Acquire("a")
	if !ok1 || !ok2 || ok3 {
		t.Fatalf("acquire: %v %v %v, want true true false", ok1, ok2, ok3)
	}
	if _, ok := s.Acquire("b"); !ok {
		t.Fatal("another key must not be limited")
	}
	r1()
	r1() // releasing twice must not free a second slot
	if _, ok := s.Acquire("a"); !ok {
		t.Fatal("released slot not reusable")
	}
	if _, ok := s.Acquire("a"); ok {
		t.Fatal("double release freed an extra slot")
	}
}

func TestRate(t *testing.T) {
	now := time.Unix(1000, 0)
	r := NewRate(5, 10)
	r.now = func() time.Time { return now }
	for i := 0; i < 10; i++ {
		if ok, _ := r.Allow("a"); !ok {
			t.Fatalf("request %d within burst denied", i+1)
		}
	}
	ok, retry := r.Allow("a")
	if ok || retry <= 0 || retry > 200*time.Millisecond {
		t.Fatalf("over burst: ok=%v retry=%v", ok, retry)
	}
	if ok, _ := r.Allow("b"); !ok {
		t.Fatal("another key must not be limited")
	}
	now = now.Add(time.Second)
	for i := 0; i < 5; i++ {
		if ok, _ := r.Allow("a"); !ok {
			t.Fatalf("refilled request %d denied", i+1)
		}
	}
	if ok, _ := r.Allow("a"); ok {
		t.Fatal("refill exceeded rps")
	}
	now = now.Add(time.Hour)
	r.Allow("c")
	if _, kept := r.buckets["b"]; kept {
		t.Fatal("idle bucket not collected")
	}
}
