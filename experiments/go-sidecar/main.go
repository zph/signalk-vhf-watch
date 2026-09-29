// vhf-watch-sidecar owns rtl_sdr and performs high-rate DSP outside Signal K.
// Stdout is a framed binary stream containing only low-rate voice and DSC PCM.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	frameVoice  byte = 1
	frameDSC    byte = 2
	frameState  byte = 3
	frameVoiceB byte = 4
)

var normalizedIQ = func() [256]float64 {
	var values [256]float64
	for index := range values {
		values[index] = (float64(index) - 127.5) / 127.5
	}
	return values
}()

type channelizer struct {
	inputRate, outputRate, firstDecimation, secondDecimation   int
	oscillatorI, oscillatorQ                                   []float64
	oscillatorIndex                                            int
	mixI, mixQ                                                 float64
	mixCount                                                   int
	filterI1, filterQ1, filterI2, filterQ2, filterI3, filterQ3 float64
	previousI, previousQ, audioSum, deemphasis, level          float64
	audioCount, outputSamples                                  int64
	checksum                                                   float64
	squelch                                                    int
}

func newChannelizer(inputRate, outputRate, offsetHz int, squelch ...int) (*channelizer, error) {
	first := inputRate / 96_000
	if first == 0 || inputRate%96_000 != 0 {
		return nil, fmt.Errorf("input rate %d must be divisible by 96000", inputRate)
	}
	intermediate := inputRate / first
	if intermediate%outputRate != 0 {
		return nil, fmt.Errorf("intermediate rate %d does not divide output rate %d", intermediate, outputRate)
	}
	value := &channelizer{
		inputRate: inputRate, outputRate: outputRate, firstDecimation: first,
		secondDecimation: intermediate / outputRate, level: math.Pi / 2,
	}
	if len(squelch) > 0 {
		value.squelch = squelch[0]
	}
	value.tune(offsetHz)
	return value, nil
}

func (c *channelizer) tune(offsetHz int) {
	period := 1
	if offsetHz != 0 {
		period = c.inputRate / gcd(c.inputRate, abs(offsetHz))
	}
	c.oscillatorI, c.oscillatorQ = make([]float64, period), make([]float64, period)
	for index := 0; index < period; index++ {
		phase := -2 * math.Pi * float64(offsetHz*index) / float64(c.inputRate)
		c.oscillatorI[index], c.oscillatorQ[index] = math.Cos(phase), math.Sin(phase)
	}
	c.oscillatorIndex = 0
	c.mixI, c.mixQ, c.mixCount = 0, 0, 0
	c.filterI1, c.filterQ1, c.filterI2, c.filterQ2, c.filterI3, c.filterQ3 = 0, 0, 0, 0, 0, 0
	c.previousI, c.previousQ, c.audioSum, c.deemphasis, c.audioCount = 0, 0, 0, 0, 0
	c.level = math.Pi / 2
}

func (c *channelizer) process(iq []byte) []int16 {
	output := make([]int16, 0, len(iq)/2/c.firstDecimation/c.secondDecimation+1)
	intermediateRate := float64(c.inputRate / c.firstDecimation)
	rfAlpha := 1 - math.Exp(-2*math.Pi*12_500/intermediateRate)
	deAlpha := 1 - math.Exp(-1/(float64(c.outputRate)*75e-6))
	for index := 0; index+1 < len(iq); index += 2 {
		sourceI, sourceQ := normalizedIQ[iq[index]], normalizedIQ[iq[index+1]]
		oscillatorI, oscillatorQ := c.oscillatorI[c.oscillatorIndex], c.oscillatorQ[c.oscillatorIndex]
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
		mixedI, mixedQ := c.mixI/float64(c.mixCount), c.mixQ/float64(c.mixCount)
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
		// Preserve unsquelched low-rate PCM. Signal K applies the configured live gate and retains
		// this stream with the discriminator-noise value for adjustable replay squelch.
		output = append(output, softLimitAudio(c.deemphasis))
	}
	return output
}

func softLimitAudio(sample float64) int16 {
	// Preserve roughly the original small-signal gain while rounding over large discriminator
	// excursions. Unsquelched FM noise can approach +/-Pi and must not hit the PCM rails.
	return int16(math.Round(math.Tanh(sample*2.5) * 30_000))
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

type options struct {
	mode, rtlPath, device                                          string
	sampleRate, center, voice, dsc, slotB, audioRate, ppm, squelch int
	gain                                                           float64
	gainSet                                                        bool
}

func main() {
	var opts options
	flag.StringVar(&opts.mode, "mode", "probe", "probe reads IQ on stdin; stream owns rtl_sdr")
	flag.StringVar(&opts.rtlPath, "rtl-sdr", "rtl_sdr", "rtl_sdr executable")
	flag.StringVar(&opts.device, "device", "0", "RTL-SDR index or serial")
	flag.IntVar(&opts.sampleRate, "sample-rate", 2_400_000, "IQ sample rate")
	flag.IntVar(&opts.center, "center", 156_750_000, "capture center frequency")
	flag.IntVar(&opts.voice, "voice", 156_800_000, "voice frequency")
	flag.IntVar(&opts.dsc, "dsc", 156_525_000, "DSC frequency")
	flag.IntVar(&opts.slotB, "slot-b", 156_525_000, "second receiver slot frequency")
	flag.IntVar(&opts.audioRate, "audio-rate", 16_000, "voice PCM sample rate")
	flag.IntVar(&opts.ppm, "ppm", 0, "frequency correction")
	flag.IntVar(&opts.squelch, "squelch", 20, "voice squelch level")
	flag.Func("gain", "manual gain in dB", func(value string) error {
		parsed, err := strconv.ParseFloat(value, 64)
		if err == nil {
			opts.gain, opts.gainSet = parsed, true
		}
		return err
	})
	flag.Parse()
	var err error
	if opts.mode == "stream" {
		err = runStream(opts)
	} else if opts.mode == "probe" {
		err = runProbe(opts, os.Stdin, os.Stdout)
	} else {
		err = fmt.Errorf("unknown mode %q", opts.mode)
	}
	if err != nil {
		fatal(err)
	}
}

func runProbe(opts options, input io.Reader, output io.Writer) error {
	voice, err := newChannelizer(opts.sampleRate, opts.audioRate, opts.voice-opts.center, opts.squelch)
	if err != nil {
		return err
	}
	slotBRate := opts.audioRate
	if opts.slotB == opts.dsc {
		slotBRate = 24_000
	}
	dsc, err := newChannelizer(opts.sampleRate, slotBRate, opts.slotB-opts.center, 0)
	if err != nil {
		return err
	}
	buffer := make([]byte, 1024*1024)
	var bytesRead int64
	var dspTime time.Duration
	started := time.Now()
	for {
		count, readErr := input.Read(buffer)
		if count > 0 {
			count -= count % 2
			began := time.Now()
			processBoth(voice, dsc, buffer[:count])
			dspTime += time.Since(began)
			bytesRead += int64(count)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	elapsed, samples := time.Since(started).Seconds(), bytesRead/2
	result := report{IQSamples: samples, ElapsedSeconds: elapsed, SamplesPerSecond: float64(samples) / elapsed, RealTimeRatio: (float64(samples) / elapsed) / float64(opts.sampleRate), DSPSeconds: dspTime.Seconds(), DSPHeadroomRatio: (float64(samples) / float64(opts.sampleRate)) / dspTime.Seconds(), VoiceAudioSamples: voice.outputSamples, DSCAudioSamples: dsc.outputSamples, VoiceLevel: voice.level, DSCLevel: dsc.level, DSPChecksum: voice.checksum + dsc.checksum}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func runStream(opts options) error {
	voice, err := newChannelizer(opts.sampleRate, opts.audioRate, opts.voice-opts.center, opts.squelch)
	if err != nil {
		return err
	}
	slotBRate := opts.audioRate
	if opts.slotB == opts.dsc {
		slotBRate = 24_000
	}
	dsc, err := newChannelizer(opts.sampleRate, slotBRate, opts.slotB-opts.center, 0)
	if err != nil {
		return err
	}
	args := []string{"-d", opts.device, "-f", strconv.Itoa(opts.center), "-s", strconv.Itoa(opts.sampleRate), "-p", strconv.Itoa(opts.ppm)}
	if opts.gainSet {
		args = append(args, "-g", strconv.FormatFloat(opts.gain, 'f', -1, 64))
	}
	args = append(args, "-")
	command := exec.Command(opts.rtlPath, args...)
	iq, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("start rtl_sdr: %w", err)
	}
	terminated := make(chan os.Signal, 1)
	signal.Notify(terminated, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-terminated:
			_ = command.Process.Signal(syscall.SIGTERM)
		case <-done:
		}
	}()
	tunes := make(chan int, 1)
	go readControls(os.Stdin, tunes)
	buffer := make([]byte, 1024*1024)
	lastState := time.Time{}
	for {
		select {
		case frequency := <-tunes:
			voice.tune(frequency - opts.center)
			opts.voice = frequency
		default:
		}
		count, readErr := iq.Read(buffer)
		if count > 0 {
			count -= count % 2
			voicePCM, dscPCM := processBoth(voice, dsc, buffer[:count])
			if err := writeVoiceFrame(os.Stdout, voicePCM, voice.level); err != nil {
				_ = command.Process.Kill()
				return err
			}
			kind := frameVoiceB
			if opts.slotB == opts.dsc {
				kind = frameDSC
			}
			if kind == frameVoiceB {
				err = writeVoiceBFrame(os.Stdout, dscPCM, dsc.level)
			} else {
				err = writePCMFrame(os.Stdout, kind, dscPCM)
			}
			if err != nil {
				_ = command.Process.Kill()
				return err
			}
			if time.Since(lastState) >= time.Second {
				state, _ := json.Marshal(map[string]any{"voice_frequency_hz": opts.voice, "voice_level": voice.level, "slot_b_frequency_hz": opts.slotB, "slot_b_level": dsc.level, "dsc_level": dsc.level, "iq_samples": voice.outputSamples * int64(opts.sampleRate) / int64(opts.audioRate)})
				if err := writeFrame(os.Stdout, frameState, state); err != nil {
					_ = command.Process.Kill()
					return err
				}
				lastState = time.Now()
			}
		}
		if readErr != nil {
			waitErr := command.Wait()
			if readErr == io.EOF && waitErr == nil {
				return nil
			}
			if waitErr != nil {
				return fmt.Errorf("rtl_sdr stopped: %w", waitErr)
			}
			return readErr
		}
	}
}

func processBoth(voice, dsc *channelizer, chunk []byte) (voicePCM, dscPCM []int16) {
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); voicePCM = voice.process(chunk) }()
	go func() { defer workers.Done(); dscPCM = dsc.process(chunk) }()
	workers.Wait()
	return
}

func readControls(input io.Reader, tunes chan int) {
	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || fields[0] != "tune" {
			continue
		}
		frequency, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		select {
		case tunes <- frequency:
		default:
			select {
			case <-tunes:
			default:
			}
			tunes <- frequency
		}
	}
}

func writePCMFrame(output io.Writer, kind byte, samples []int16) error {
	payload := make([]byte, len(samples)*2)
	for index, sample := range samples {
		binary.LittleEndian.PutUint16(payload[index*2:], uint16(sample))
	}
	return writeFrame(output, kind, payload)
}

func writeVoiceFrame(output io.Writer, samples []int16, discriminatorNoise float64) error {
	return writeMeasuredVoiceFrame(output, frameVoice, samples, discriminatorNoise)
}
func writeVoiceBFrame(output io.Writer, samples []int16, discriminatorNoise float64) error {
	return writeMeasuredVoiceFrame(output, frameVoiceB, samples, discriminatorNoise)
}
func writeMeasuredVoiceFrame(output io.Writer, kind byte, samples []int16, discriminatorNoise float64) error {
	payload := make([]byte, 8+len(samples)*2)
	binary.LittleEndian.PutUint64(payload, math.Float64bits(discriminatorNoise))
	for index, sample := range samples {
		binary.LittleEndian.PutUint16(payload[8+index*2:], uint16(sample))
	}
	return writeFrame(output, kind, payload)
}
func writeFrame(output io.Writer, kind byte, payload []byte) error {
	header := [5]byte{kind}
	binary.LittleEndian.PutUint32(header[1:], uint32(len(payload)))
	if _, err := output.Write(header[:]); err != nil {
		return err
	}
	_, err := output.Write(payload)
	return err
}
func fatal(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
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
