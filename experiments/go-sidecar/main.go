// vhf-go-sidecar is a bounded DSP throughput probe for the experimental VHF Watch receiver.
// It reads unsigned 8-bit interleaved IQ on stdin and fully channelizes two NFM channels without
// retaining audio. rtl_sdr can feed it directly during a controlled AIS interruption.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"sync"
	"time"
)

var normalizedIQ = func() [256]float64 {
	var values [256]float64
	for index := range values {
		values[index] = (float64(index) - 127.5) / 127.5
	}
	return values
}()

type channelizer struct {
	inputRate, outputRate             int
	firstDecimation, secondDecimation int
	oscillatorI, oscillatorQ          []float64
	oscillatorIndex                   int
	mixI, mixQ                        float64
	mixCount                          int
	filterI1, filterQ1                float64
	filterI2, filterQ2                float64
	filterI3, filterQ3                float64
	previousI, previousQ              float64
	audioSum, deemphasis, level       float64
	audioCount, outputSamples         int64
	checksum                          float64
}

func newChannelizer(inputRate, outputRate, offsetHz int) (*channelizer, error) {
	first := inputRate / 96_000
	if first == 0 || inputRate%96_000 != 0 {
		return nil, fmt.Errorf("input rate %d must be divisible by 96000", inputRate)
	}
	intermediate := inputRate / first
	if intermediate%outputRate != 0 {
		return nil, fmt.Errorf("intermediate rate %d does not divide output rate %d", intermediate, outputRate)
	}
	period := 1
	if offsetHz != 0 {
		period = inputRate / gcd(inputRate, abs(offsetHz))
	}
	value := &channelizer{
		inputRate: inputRate, outputRate: outputRate,
		firstDecimation: first, secondDecimation: intermediate / outputRate,
		oscillatorI: make([]float64, period), oscillatorQ: make([]float64, period),
	}
	for index := 0; index < period; index++ {
		phase := -2 * math.Pi * float64(offsetHz*index) / float64(inputRate)
		value.oscillatorI[index] = math.Cos(phase)
		value.oscillatorQ[index] = math.Sin(phase)
	}
	return value, nil
}

func (c *channelizer) process(iq []byte) {
	intermediateRate := float64(c.inputRate / c.firstDecimation)
	rfAlpha := 1 - math.Exp(-2*math.Pi*12_500/intermediateRate)
	deAlpha := 1 - math.Exp(-1/(float64(c.outputRate)*75e-6))
	for index := 0; index+1 < len(iq); index += 2 {
		sourceI := normalizedIQ[iq[index]]
		sourceQ := normalizedIQ[iq[index+1]]
		oscillatorI := c.oscillatorI[c.oscillatorIndex]
		oscillatorQ := c.oscillatorQ[c.oscillatorIndex]
		c.mixI += sourceI*oscillatorI - sourceQ*oscillatorQ
		c.mixQ += sourceI*oscillatorQ + sourceQ*oscillatorI
		c.oscillatorIndex++
		if c.oscillatorIndex == len(c.oscillatorI) {
			c.oscillatorIndex = 0
		}
		c.mixCount++
		if c.mixCount < c.firstDecimation {
			continue
		}
		mixedI := c.mixI / float64(c.mixCount)
		mixedQ := c.mixQ / float64(c.mixCount)
		c.mixI, c.mixQ, c.mixCount = 0, 0, 0
		c.filterI1 += rfAlpha * (mixedI - c.filterI1)
		c.filterQ1 += rfAlpha * (mixedQ - c.filterQ1)
		c.filterI2 += rfAlpha * (c.filterI1 - c.filterI2)
		c.filterQ2 += rfAlpha * (c.filterQ1 - c.filterQ2)
		c.filterI3 += rfAlpha * (c.filterI2 - c.filterI3)
		c.filterQ3 += rfAlpha * (c.filterQ2 - c.filterQ3)
		cross := c.previousI*c.filterQ3 - c.previousQ*c.filterI3
		dot := c.previousI*c.filterI3 + c.previousQ*c.filterQ3
		c.previousI, c.previousQ = c.filterI3, c.filterQ3
		demodulated := math.Atan2(cross, dot)
		c.level = c.level*0.995 + math.Abs(demodulated)*0.005
		c.audioSum += demodulated
		c.audioCount++
		if c.audioCount < int64(c.secondDecimation) {
			continue
		}
		sample := c.audioSum / float64(c.audioCount)
		c.audioSum, c.audioCount = 0, 0
		c.deemphasis += deAlpha * (sample - c.deemphasis)
		c.checksum += c.deemphasis
		c.outputSamples++
	}
}

type report struct {
	IQSamples         int64   `json:"iq_samples"`
	ElapsedSeconds    float64 `json:"elapsed_seconds"`
	SamplesPerSecond  float64 `json:"samples_per_second"`
	RealTimeRatio     float64 `json:"real_time_ratio"`
	DSPSeconds        float64 `json:"dsp_seconds"`
	DSPHeadroomRatio  float64 `json:"dsp_headroom_ratio"`
	VoiceAudioSamples int64   `json:"voice_audio_samples"`
	DSCAudioSamples   int64   `json:"dsc_audio_samples"`
	VoiceLevel        float64 `json:"voice_level"`
	DSCLevel          float64 `json:"dsc_level"`
	DSPChecksum       float64 `json:"dsp_checksum"`
}

func main() {
	sampleRate := flag.Int("sample-rate", 2_400_000, "unsigned 8-bit complex IQ sample rate")
	center := flag.Int("center", 156_750_000, "capture center frequency")
	voiceFrequency := flag.Int("voice", 156_800_000, "voice channel frequency")
	dscFrequency := flag.Int("dsc", 156_525_000, "DSC channel frequency")
	flag.Parse()
	voice, err := newChannelizer(*sampleRate, 16_000, *voiceFrequency-*center)
	if err != nil {
		fatal(err)
	}
	dsc, err := newChannelizer(*sampleRate, 24_000, *dscFrequency-*center)
	if err != nil {
		fatal(err)
	}
	buffer := make([]byte, 1024*1024)
	var bytesRead int64
	var dspTime time.Duration
	started := time.Now()
	for {
		count, readErr := os.Stdin.Read(buffer)
		if count > 0 {
			count -= count % 2
			chunk := buffer[:count]
			processingStarted := time.Now()
			var workers sync.WaitGroup
			workers.Add(2)
			go func() {
				defer workers.Done()
				voice.process(chunk)
			}()
			go func() {
				defer workers.Done()
				dsc.process(chunk)
			}()
			workers.Wait()
			dspTime += time.Since(processingStarted)
			bytesRead += int64(count)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			fatal(readErr)
		}
	}
	elapsed := time.Since(started).Seconds()
	samples := bytesRead / 2
	result := report{
		IQSamples: samples, ElapsedSeconds: elapsed,
		SamplesPerSecond:  float64(samples) / elapsed,
		RealTimeRatio:     (float64(samples) / elapsed) / float64(*sampleRate),
		DSPSeconds:        dspTime.Seconds(),
		DSPHeadroomRatio:  (float64(samples) / float64(*sampleRate)) / dspTime.Seconds(),
		VoiceAudioSamples: voice.outputSamples, DSCAudioSamples: dsc.outputSamples,
		VoiceLevel: voice.level, DSCLevel: dsc.level,
		DSPChecksum: voice.checksum + dsc.checksum,
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func gcd(left, right int) int {
	for right != 0 {
		left, right = right, left%right
	}
	return left
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
