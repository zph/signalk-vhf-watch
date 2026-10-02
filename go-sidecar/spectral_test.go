package vhfaudio

import (
	"math"
	"testing"
)

func rootMeanSquare(samples []int16, start, end int) float64 {
	power := 0.0
	for _, sample := range samples[start:end] {
		power += float64(sample) * float64(sample)
	}
	return math.Sqrt(power / float64(end-start))
}

func TestSpectralFilterReducesNoiseAndPreservesVoice(t *testing.T) {
	const sampleRate = 16_000
	input := make([]int16, sampleRate*3)
	state := uint32(1)
	for index := range input {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		noise := (float64(state)/4_294_967_296 - 0.5) * 0.08
		voice := 0.0
		if index >= sampleRate {
			voice = 0.08 * math.Sin(2*math.Pi*1_000*float64(index)/sampleRate)
		}
		input[index] = int16(math.Round((noise + voice) * 32767))
	}
	reducer := newSpectralReducer(sampleRate)
	output := make([]int16, len(input))
	for index := 0; index < len(input); index += 1_600 {
		copy(output[index:], reducer.process(input[index:index+1_600]))
	}
	latency := reducer.latency
	if rootMeanSquare(output, 8_000+latency, 16_000+latency) >= rootMeanSquare(input, 8_000, 16_000)*0.6 {
		t.Fatal("steady noise was not reduced")
	}
	if rootMeanSquare(output, 32_000+latency, 40_000+latency) <= 1_500 {
		t.Fatal("voice tone was removed")
	}
}

func TestSpectralFilterDoesNotLearnContinuousToneAsNoise(t *testing.T) {
	const sampleRate = 16_000
	input := make([]int16, sampleRate*2)
	for index := range input {
		input[index] = int16(math.Round(0.08 * math.Sin(2*math.Pi*1_000*float64(index)/sampleRate) * 32767))
	}
	reducer := newSpectralReducer(sampleRate)
	output := reducer.process(input)
	start := sampleRate + reducer.latency
	if rootMeanSquare(output, start, start+4_000) <= rootMeanSquare(input, sampleRate, sampleRate+4_000)*0.9 {
		t.Fatal("continuous voice tone was treated as noise")
	}
}
