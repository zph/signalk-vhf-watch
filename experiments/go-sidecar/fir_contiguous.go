package main

// contiguousFIRDecimator keeps a duplicated interleaved I/Q ring. After each input sample,
// the most recent tap-length window is contiguous, including when the logical ring wraps.
// This gives the ARM64 kernel two adjacent lanes (I and Q) and avoids per-tap wrap branches.
type contiguousFIRDecimator struct {
	coefficients []float64
	pairs        []float64
	history      []float64
	taps         int
	center       int
	writeIndex   int
	decimation   int
	count        int
}

func newContiguousFIRDecimator(sampleRate, cutoffHz, taps, decimation int) *contiguousFIRDecimator {
	if taps < 3 || taps%2 == 0 {
		panic("FIR tap count must be odd and at least three")
	}
	coefficients := lowpassCoefficients(sampleRate, cutoffHz, taps)
	pairs := make([]float64, taps/2)
	copy(pairs, coefficients[:taps/2])
	return &contiguousFIRDecimator{
		coefficients: coefficients,
		pairs:        pairs,
		history:      make([]float64, taps*4), // two copies of interleaved I/Q samples
		taps:         taps,
		center:       taps / 2,
		decimation:   decimation,
	}
}

func (f *contiguousFIRDecimator) reset() {
	clear(f.history)
	f.writeIndex, f.count = 0, 0
}

// pushSample stores both copies and returns the start of the chronological tap window when
// decimation produces an output. An incomplete initial window is intentionally zero padded.
func (f *contiguousFIRDecimator) pushSample(inputI, inputQ float64) (int, bool) {
	write := f.writeIndex * 2
	f.history[write], f.history[write+1] = inputI, inputQ
	duplicate := write + f.taps*2
	f.history[duplicate], f.history[duplicate+1] = inputI, inputQ
	f.writeIndex++
	if f.writeIndex == f.taps {
		f.writeIndex = 0
	}
	f.count++
	if f.count < f.decimation {
		return 0, false
	}
	f.count = 0
	return f.writeIndex, true
}

func (f *contiguousFIRDecimator) push(inputI, inputQ float64) (outputI, outputQ float64, ready bool) {
	start, ready := f.pushSample(inputI, inputQ)
	if !ready {
		return 0, 0, false
	}
	window := f.history[start*2 : (start+f.taps)*2]
	outputI, outputQ = firDotKernel(window, f.pairs)
	center := (start + f.center) * 2
	centerCoefficient := f.coefficients[f.center]
	outputI += centerCoefficient * f.history[center]
	outputQ += centerCoefficient * f.history[center+1]
	return outputI, outputQ, true
}

// pushScalar provides the exact contiguous reference used to isolate the SIMD kernel.
func (f *contiguousFIRDecimator) pushScalar(inputI, inputQ float64) (outputI, outputQ float64, ready bool) {
	start, ready := f.pushSample(inputI, inputQ)
	if !ready {
		return 0, 0, false
	}
	window := f.history[start*2 : (start+f.taps)*2]
	outputI, outputQ = firDotScalar(window, f.pairs)
	center := (start + f.center) * 2
	centerCoefficient := f.coefficients[f.center]
	outputI += centerCoefficient * f.history[center]
	outputQ += centerCoefficient * f.history[center+1]
	return outputI, outputQ, true
}

func firDotScalar(window, pairCoefficients []float64) (outputI, outputQ float64) {
	for pair, pairs := 0, len(pairCoefficients); pair < pairs; pair++ {
		leftIndex, rightIndex := pair*2, (pairs*2-pair)*2
		inputI := window[leftIndex] + window[rightIndex]
		inputQ := window[leftIndex+1] + window[rightIndex+1]
		coefficient := pairCoefficients[pair]
		outputI += coefficient * inputI
		outputQ += coefficient * inputQ
	}
	return outputI, outputQ
}
