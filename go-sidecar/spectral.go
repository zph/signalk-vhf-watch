package vhfaudio

import "math"

type spectralReducer struct {
	sampleRate      int
	size            int
	hop             int
	latency         int
	windowFrames    int
	window          []float64
	input           []float64
	pending         []float64
	weights         []float64
	real            []float64
	imaginary       []float64
	smoothedPower   []float64
	currentMinimum  []float64
	previousMinimum []float64
	targetGain      []float64
	gain            []float64
	sampleIndex     int
	frames          int
	noiseFrames     int
}

func newSpectralReducer(sampleRate int) *spectralReducer {
	size := 1
	for size < int(math.Ceil(float64(sampleRate)*0.032)) {
		size *= 2
	}
	hop := size / 2
	reducer := &spectralReducer{
		sampleRate:      sampleRate,
		size:            size,
		hop:             hop,
		latency:         size - 1,
		windowFrames:    int(math.Ceil(float64(sampleRate) * 0.6 / float64(hop))),
		window:          make([]float64, size),
		input:           make([]float64, size),
		pending:         make([]float64, size*4),
		weights:         make([]float64, size*4),
		real:            make([]float64, size),
		imaginary:       make([]float64, size),
		smoothedPower:   make([]float64, hop+1),
		currentMinimum:  make([]float64, hop+1),
		previousMinimum: make([]float64, hop+1),
		targetGain:      make([]float64, hop+1),
		gain:            make([]float64, hop+1),
	}
	for index := range reducer.window {
		reducer.window[index] = math.Sin(math.Pi * (float64(index) + 0.5) / float64(size))
	}
	for index := range reducer.gain {
		reducer.currentMinimum[index] = math.Inf(1)
		reducer.previousMinimum[index] = math.Inf(1)
		reducer.gain[index] = 1
	}
	return reducer
}

func (reducer *spectralReducer) process(pcm []int16) []int16 {
	output := make([]int16, len(pcm))
	for index, sample := range pcm {
		reducer.input[reducer.sampleIndex%reducer.size] = float64(sample) / 32768
		if reducer.sampleIndex >= reducer.latency && (reducer.sampleIndex-reducer.latency)%reducer.hop == 0 {
			reducer.processFrame()
		}
		outputIndex := reducer.sampleIndex - reducer.latency
		if outputIndex >= 0 {
			slot := outputIndex % len(reducer.pending)
			value := 0.0
			if reducer.weights[slot] > 1e-12 {
				value = reducer.pending[slot] / reducer.weights[slot]
			}
			output[index] = clampSample(value * 32768)
			reducer.pending[slot] = 0
			reducer.weights[slot] = 0
		}
		reducer.sampleIndex++
	}
	return output
}

func (reducer *spectralReducer) processFrame() {
	start := reducer.sampleIndex - reducer.latency
	for index := 0; index < reducer.size; index++ {
		reducer.real[index] = reducer.input[(start+index)%reducer.size] * reducer.window[index]
		reducer.imaginary[index] = 0
	}
	transform(reducer.real, reducer.imaginary, false)

	spectralSum := 0.0
	logSum := 0.0
	bandBins := 0
	for bin := 0; bin <= reducer.hop; bin++ {
		frequency := float64(bin*reducer.sampleRate) / float64(reducer.size)
		if frequency < 180 || frequency > 3_400 {
			continue
		}
		power := reducer.real[bin]*reducer.real[bin] + reducer.imaginary[bin]*reducer.imaginary[bin] + 1e-12
		spectralSum += power
		logSum += math.Log(power)
		bandBins++
	}
	flatness := math.Exp(logSum/float64(bandBins)) / (spectralSum / float64(bandBins))
	noiseLike := flatness > 0.3
	if noiseLike {
		reducer.noiseFrames++
	}

	for bin := 0; bin <= reducer.hop; bin++ {
		power := reducer.real[bin]*reducer.real[bin] + reducer.imaginary[bin]*reducer.imaginary[bin]
		smoothed := power
		if reducer.frames > 0 {
			smoothed = reducer.smoothedPower[bin]*0.8 + power*0.2
		}
		reducer.smoothedPower[bin] = smoothed
		if noiseLike && smoothed < reducer.previousMinimum[bin]*2.5 {
			reducer.currentMinimum[bin] = math.Min(reducer.currentMinimum[bin], smoothed)
		}
		frequency := float64(bin*reducer.sampleRate) / float64(reducer.size)
		bandLimit := 1.0
		if frequency < 180 || frequency > 3_400 {
			bandLimit = 0.08
		}
		noise := math.Min(reducer.currentMinimum[bin], reducer.previousMinimum[bin]) * 1.4
		spectralGain := 1.0
		if reducer.frames >= reducer.windowFrames && reducer.noiseFrames >= 8 && !math.IsInf(noise, 0) {
			spectralGain = math.Max(0.12, math.Min(1, 1-noise/math.Max(power, 1e-12)))
		}
		reducer.targetGain[bin] = bandLimit * spectralGain
	}
	for bin := 0; bin <= reducer.hop; bin++ {
		left := max(0, bin-1)
		right := min(reducer.hop, bin+1)
		target := (reducer.targetGain[left] + reducer.targetGain[bin] + reducer.targetGain[right]) / 3
		reducer.gain[bin] = reducer.gain[bin]*0.7 + target*0.3
		reducer.real[bin] *= reducer.gain[bin]
		reducer.imaginary[bin] *= reducer.gain[bin]
		if bin > 0 && bin < reducer.hop {
			reducer.real[reducer.size-bin] *= reducer.gain[bin]
			reducer.imaginary[reducer.size-bin] *= reducer.gain[bin]
		}
	}
	transform(reducer.real, reducer.imaginary, true)
	for index := 0; index < reducer.size; index++ {
		slot := (start + index) % len(reducer.pending)
		window := reducer.window[index]
		reducer.pending[slot] += reducer.real[index] * window
		reducer.weights[slot] += window * window
	}
	reducer.frames++
	if reducer.frames%reducer.windowFrames == 0 {
		for bin := 0; bin <= reducer.hop; bin++ {
			if !math.IsInf(reducer.currentMinimum[bin], 0) {
				reducer.previousMinimum[bin] = reducer.currentMinimum[bin]
			}
			reducer.currentMinimum[bin] = math.Inf(1)
		}
	}
}

func transform(real, imaginary []float64, inverse bool) {
	length := len(real)
	for index, reversed := 1, 0; index < length; index++ {
		bit := length / 2
		for reversed&bit != 0 {
			reversed ^= bit
			bit >>= 1
		}
		reversed ^= bit
		if index >= reversed {
			continue
		}
		real[index], real[reversed] = real[reversed], real[index]
		imaginary[index], imaginary[reversed] = imaginary[reversed], imaginary[index]
	}
	for size := 2; size <= length; size *= 2 {
		angle := -2 * math.Pi / float64(size)
		if inverse {
			angle = -angle
		}
		stepReal, stepImaginary := math.Cos(angle), math.Sin(angle)
		for start := 0; start < length; start += size {
			twiddleReal, twiddleImaginary := 1.0, 0.0
			for offset := 0; offset < size/2; offset++ {
				left, right := start+offset, start+offset+size/2
				valueReal := real[right]*twiddleReal - imaginary[right]*twiddleImaginary
				valueImaginary := real[right]*twiddleImaginary + imaginary[right]*twiddleReal
				real[right], imaginary[right] = real[left]-valueReal, imaginary[left]-valueImaginary
				real[left], imaginary[left] = real[left]+valueReal, imaginary[left]+valueImaginary
				twiddleReal, twiddleImaginary = twiddleReal*stepReal-twiddleImaginary*stepImaginary, twiddleReal*stepImaginary+twiddleImaginary*stepReal
			}
		}
	}
	if inverse {
		for index := range real {
			real[index] /= float64(length)
			imaginary[index] /= float64(length)
		}
	}
}
