//go:build arm64

package main

import "testing"

func TestNEONFIRKernelMatchesContiguousScalarWithinDoubleTolerance(t *testing.T) {
	for _, config := range []struct {
		taps, decimation int
	}{{3, 1}, {63, 1}, {63, 5}, {63, 7}, {511, 5}, {511, 64}} {
		vector := newContiguousFIRDecimator(480_000, 9_000, config.taps, config.decimation)
		scalar := newContiguousFIRDecimator(480_000, 9_000, config.taps, config.decimation)
		seed := uint32(0xa71a64)
		for sample := 0; sample < 30_000; sample++ {
			if sample == 11_111 {
				vector.reset()
				scalar.reset()
			}
			seed = seed*1664525 + 1013904223
			inputI := (float64(seed>>8)/float64(1<<24))*2 - 1
			seed = seed*1664525 + 1013904223
			inputQ := (float64(seed>>8)/float64(1<<24))*2 - 1
			gotI, gotQ, gotReady := vector.push(inputI, inputQ)
			wantI, wantQ, wantReady := scalar.pushScalar(inputI, inputQ)
			if gotReady != wantReady {
				t.Fatalf("%d-tap readiness at sample %d = %v, want %v", config.taps, sample, gotReady, wantReady)
			}
			if gotReady && (gotI != wantI || gotQ != wantQ) {
				t.Fatalf("%d-tap NEON output at sample %d differs: got (%0.17g, %0.17g), scalar (%0.17g, %0.17g)", config.taps, sample, gotI, gotQ, wantI, wantQ)
			}
		}
	}
}
