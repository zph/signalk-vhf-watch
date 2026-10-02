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
	frameVoice          byte = 1
	frameDSC            byte = 2
	frameState          byte = 3
	frameVoiceB         byte = 4
	frameVoiceBackfill  byte = 5
	frameVoiceBBackfill byte = 6
	frameVoiceSpansBackfill  byte = 7
	frameVoiceBSpansBackfill byte = 8
	channelRate              = 96_000
	spectrumFFTSize          = 4096
	spectrumStride           = 32768
)

var frameWriteMutex sync.Mutex

type iqRing struct {
	buffer     []byte
	write      int
	filled     int
	sampleRate int
}

func newIQRing(sampleRate, seconds int) *iqRing {
	return &iqRing{buffer: make([]byte, sampleRate*2*seconds), sampleRate: sampleRate}
}

func (r *iqRing) append(chunk []byte) {
	if len(r.buffer) == 0 || len(chunk) == 0 {
		return
	}
	if len(chunk) >= len(r.buffer) {
		copy(r.buffer, chunk[len(chunk)-len(r.buffer):])
		r.write, r.filled = 0, len(r.buffer)
		return
	}
	first := min(len(chunk), len(r.buffer)-r.write)
	copy(r.buffer[r.write:], chunk[:first])
	copy(r.buffer, chunk[first:])
	r.write = (r.write + len(chunk)) % len(r.buffer)
	r.filled = min(len(r.buffer), r.filled+len(chunk))
}

func (r *iqRing) snapshot() ([]byte, int64) {
	if r.filled == 0 {
		return nil, 0
	}
	result := make([]byte, r.filled)
	start := (r.write - r.filled + len(r.buffer)) % len(r.buffer)
	first := min(r.filled, len(r.buffer)-start)
	copy(result, r.buffer[start:start+first])
	copy(result[first:], r.buffer[:r.filled-first])
	duration := time.Duration(float64(len(result)/2) / float64(r.sampleRate) * float64(time.Second))
	return result, time.Now().Add(-duration).UnixMilli()
}

type backfillJob struct {
	slot                                                          byte
	frequency, center, sampleRate, audioRate, rfCutoffHz, squelch int
	iq                                                            []byte
	startedAt                                                     int64
}

type backfillSpan struct {
	byteCount uint32
	noise     float64
}

var normalizedIQ = func() [256]float64 {
	var values [256]float64
	for index := range values {
		values[index] = (float64(index) - 127.5) / 127.5
	}
	return values
}()

type channelizer struct {
	inputRate, outputRate, audioDecimation      int
	oscillatorI, oscillatorQ                    []float64
	oscillatorIndex                             int
	firstRF, channelRF                          *complexFIRDecimator
	previousI, previousQ, carrierBias, audioSum float64
	carrierAlpha, maximumCarrierBias            float64
	deemphasis, level                           float64
	audioCount, outputSamples                   int64
	checksum                                    float64
	squelch                                     int
	previousValid                               bool
}

type complexFIRDecimator struct {
	coefficients []float64
	historyI     []float64
	historyQ     []float64
	writeIndex   int
	decimation   int
	count        int
}

// spectrumScanner performs a deliberately sparse FFT over the shared wideband IQ stream. It is
// only a traffic detector: the FIR channelizers remain responsible for producing playable audio
// and confirming voice with discriminator squelch. Sampling one FFT every spectrumStride input
// samples keeps the all-channel detector much cheaper than demodulating every channel.
type spectrumScanner struct {
	inputRate, center int
	frequencies       []int
	window            []complex128
	fill, skip        int
	sums              map[int]float64
	frames            int
}

func newSpectrumScanner(inputRate, center int, frequencies []int) *spectrumScanner {
	return &spectrumScanner{
		inputRate: inputRate, center: center, frequencies: frequencies,
		window: make([]complex128, spectrumFFTSize), sums: make(map[int]float64),
	}
}

func (s *spectrumScanner) process(iq []byte) {
	if len(s.frequencies) == 0 {
		return
	}
	for index := 0; index+1 < len(iq); index += 2 {
		if s.skip > 0 {
			s.skip--
			continue
		}
		weight := 0.5 - 0.5*math.Cos(2*math.Pi*float64(s.fill)/float64(spectrumFFTSize-1))
		s.window[s.fill] = complex(normalizedIQ[iq[index]]*weight, normalizedIQ[iq[index+1]]*weight)
		s.fill++
		if s.fill == spectrumFFTSize {
			s.measure()
			s.fill = 0
			s.skip = spectrumStride - spectrumFFTSize
		}
	}
}

func (s *spectrumScanner) measure() {
	fft(s.window)
	binHz := float64(s.inputRate) / spectrumFFTSize
	for _, frequency := range s.frequencies {
		centerBin := int(math.Round(float64(frequency-s.center) / binHz))
		signal, signalBins := 0.0, 0
		noise, noiseBins := 0.0, 0
		for offset := -22; offset <= 22; offset++ {
			absolute := offset
			if absolute < 0 {
				absolute = -absolute
			}
			if absolute > 20 || (absolute > 7 && absolute < 12) {
				continue
			}
			// RTL tuners commonly leave a narrow DC spike at the capture center. Ignore its
			// innermost bins while retaining the modulated shoulders of Channel 15.
			if centerBin == 0 && absolute <= 1 {
				continue
			}
			bin := (centerBin + offset + spectrumFFTSize) % spectrumFFTSize
			power := real(s.window[bin])*real(s.window[bin]) + imag(s.window[bin])*imag(s.window[bin])
			if absolute <= 7 {
				signal += power
				signalBins++
			} else {
				noise += power
				noiseBins++
			}
		}
		if noise > 0 {
			ratio := (signal / float64(signalBins)) / (noise / float64(noiseBins))
			s.sums[frequency] += math.Max(0, ratio-1)
		}
	}
	s.frames++
}

func (s *spectrumScanner) snapshot() map[string]float64 {
	result := make(map[string]float64, len(s.frequencies))
	if s.frames > 0 {
		for _, frequency := range s.frequencies {
			result[strconv.Itoa(frequency)] = s.sums[frequency] / float64(s.frames)
		}
	}
	clear(s.sums)
	s.frames = 0
	return result
}

func fft(values []complex128) {
	for index, reversed := 1, 0; index < len(values); index++ {
		bit := len(values) >> 1
		for reversed&bit != 0 {
			reversed ^= bit
			bit >>= 1
		}
		reversed ^= bit
		if index < reversed {
			values[index], values[reversed] = values[reversed], values[index]
		}
	}
	for width := 2; width <= len(values); width <<= 1 {
		step := complex(math.Cos(-2*math.Pi/float64(width)), math.Sin(-2*math.Pi/float64(width)))
		for start := 0; start < len(values); start += width {
			factor := complex(1, 0)
			for offset := 0; offset < width/2; offset++ {
				even, odd := values[start+offset], values[start+offset+width/2]*factor
				values[start+offset], values[start+offset+width/2] = even+odd, even-odd
				factor *= step
			}
		}
	}
}

func lowpassCoefficients(sampleRate, cutoffHz, taps int) []float64 {
	if taps < 3 || taps%2 == 0 {
		panic("FIR tap count must be odd and at least three")
	}
	coefficients := make([]float64, taps)
	middle := float64(taps-1) / 2
	normalizedCutoff := float64(cutoffHz) / float64(sampleRate)
	var sum float64
	for index := range coefficients {
		distance := float64(index) - middle
		value := 2 * normalizedCutoff
		if distance != 0 {
			value = math.Sin(2*math.Pi*normalizedCutoff*distance) / (math.Pi * distance)
		}
		// A Blackman window trades a little transition width for strong rejection of aliased
		// wideband noise and adjacent marine channels.
		window := 0.42 - 0.5*math.Cos(2*math.Pi*float64(index)/float64(taps-1)) +
			0.08*math.Cos(4*math.Pi*float64(index)/float64(taps-1))
		coefficients[index] = value * window
		sum += coefficients[index]
	}
	for index := range coefficients {
		coefficients[index] /= sum
	}
	return coefficients
}

func newComplexFIRDecimator(sampleRate, cutoffHz, taps, decimation int) *complexFIRDecimator {
	coefficients := lowpassCoefficients(sampleRate, cutoffHz, taps)
	return &complexFIRDecimator{
		coefficients: coefficients,
		historyI:     make([]float64, taps), historyQ: make([]float64, taps),
		decimation: decimation,
	}
}

func (f *complexFIRDecimator) reset() {
	clear(f.historyI)
	clear(f.historyQ)
	f.writeIndex, f.count = 0, 0
}

func (f *complexFIRDecimator) push(inputI, inputQ float64) (outputI, outputQ float64, ready bool) {
	f.historyI[f.writeIndex], f.historyQ[f.writeIndex] = inputI, inputQ
	f.writeIndex++
	if f.writeIndex == len(f.coefficients) {
		f.writeIndex = 0
	}
	f.count++
	if f.count < f.decimation {
		return 0, 0, false
	}
	f.count = 0
	historyIndex := f.writeIndex - 1
	if historyIndex < 0 {
		historyIndex = len(f.coefficients) - 1
	}
	for _, coefficient := range f.coefficients {
		outputI += coefficient * f.historyI[historyIndex]
		outputQ += coefficient * f.historyQ[historyIndex]
		historyIndex--
		if historyIndex < 0 {
			historyIndex = len(f.coefficients) - 1
		}
	}
	return outputI, outputQ, true
}

func newChannelizer(inputRate, outputRate, offsetHz int, squelch ...int) (*channelizer, error) {
	return newChannelizerWithRFCutoff(inputRate, outputRate, offsetHz, 9_000, squelch...)
}

func newChannelizerWithRFCutoff(inputRate, outputRate, offsetHz, rfCutoffHz int, squelch ...int) (*channelizer, error) {
	const firstRFRate = 480_000
	if inputRate%firstRFRate != 0 || firstRFRate%channelRate != 0 {
		return nil, fmt.Errorf("input rate %d must be divisible by 96000", inputRate)
	}
	if channelRate%outputRate != 0 {
		return nil, fmt.Errorf("channel rate %d does not divide output rate %d", channelRate, outputRate)
	}
	value := &channelizer{
		inputRate: inputRate, outputRate: outputRate,
		audioDecimation: channelRate / outputRate, level: math.Pi / 2,
		firstRF:            newComplexFIRDecimator(inputRate, 120_000, 63, inputRate/firstRFRate),
		channelRF:          newComplexFIRDecimator(firstRFRate, rfCutoffHz, 511, firstRFRate/channelRate),
		carrierAlpha:       1 - math.Exp(-1/(float64(channelRate)*2.0)),
		maximumCarrierBias: 2 * math.Pi * 1_500 / channelRate,
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
	c.firstRF.reset()
	c.channelRF.reset()
	c.previousI, c.previousQ, c.carrierBias = 0, 0, 0
	c.audioSum, c.deemphasis, c.audioCount = 0, 0, 0
	c.previousValid = false
	c.level = math.Pi / 2
}

func (c *channelizer) process(iq []byte) []int16 {
	output := make([]int16, 0, len(iq)/2/(c.inputRate/channelRate)/c.audioDecimation+1)
	deAlpha := 1 - math.Exp(-1/(float64(c.outputRate)*75e-6))
	for index := 0; index+1 < len(iq); index += 2 {
		sourceI, sourceQ := normalizedIQ[iq[index]], normalizedIQ[iq[index+1]]
		oscillatorI, oscillatorQ := c.oscillatorI[c.oscillatorIndex], c.oscillatorQ[c.oscillatorIndex]
		mixedI := sourceI*oscillatorI - sourceQ*oscillatorQ
		mixedQ := sourceI*oscillatorQ + sourceQ*oscillatorI
		c.oscillatorIndex++
		if c.oscillatorIndex == len(c.oscillatorI) {
			c.oscillatorIndex = 0
		}
		firstI, firstQ, ready := c.firstRF.push(mixedI, mixedQ)
		if !ready {
			continue
		}
		filteredI, filteredQ, ready := c.channelRF.push(firstI, firstQ)
		if !ready {
			continue
		}
		demodulated := c.discriminate(filteredI, filteredQ)
		c.level = c.level*0.995 + math.Abs(demodulated)*0.005
		c.audioSum += demodulated
		c.audioCount++
		if c.audioCount < int64(c.audioDecimation) {
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

func (c *channelizer) discriminate(filteredI, filteredQ float64) float64 {
	// Polar FM discrimination is already an ideal amplitude limiter: scaling either complex
	// sample by a positive magnitude multiplies cross and dot equally, leaving atan2 unchanged.
	// Avoid fabricating phase only when the filtered magnitude is numerically empty.
	magnitudeSquared := filteredI*filteredI + filteredQ*filteredQ
	rawPhase := 0.0
	if magnitudeSquared >= 1e-18 {
		if c.previousValid {
			cross := c.previousI*filteredQ - c.previousQ*filteredI
			dot := c.previousI*filteredI + c.previousQ*filteredQ
			rawPhase = math.Atan2(cross, dot)
		}
		c.previousI, c.previousQ, c.previousValid = filteredI, filteredQ, true
	}
	carrierError := math.Atan2(math.Sin(rawPhase-c.carrierBias), math.Cos(rawPhase-c.carrierBias))
	c.carrierBias += c.carrierAlpha * carrierError
	c.carrierBias = math.Max(-c.maximumCarrierBias, math.Min(c.maximumCarrierBias, c.carrierBias))
	return math.Atan2(math.Sin(rawPhase-c.carrierBias), math.Cos(rawPhase-c.carrierBias))
}

func (c *channelizer) carrierOffsetHz() float64 {
	return c.carrierBias * channelRate / (2 * math.Pi)
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
	VoiceCarrierHz    float64 `json:"voice_carrier_offset_hz"`
	DSCCarrierHz      float64 `json:"dsc_carrier_offset_hz"`
	IQEdgeFraction    float64 `json:"iq_edge_fraction"`
	DSPChecksum       float64 `json:"dsp_checksum"`
}

type options struct {
	mode, rtlPath, device                                          string
	sampleRate, center, voice, dsc, slotB, audioRate, ppm, squelch int
	rfCutoffHz                                                     int
	scanFrequencies                                                []int
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
	flag.IntVar(&opts.rfCutoffHz, "rf-cutoff", 9_000, "pre-demodulation channel low-pass cutoff in Hz")
	flag.Func("scan-frequencies", "comma-separated frequencies for wideband traffic detection", func(value string) error {
		for _, field := range strings.Split(value, ",") {
			frequency, err := strconv.Atoi(strings.TrimSpace(field))
			if err != nil {
				return err
			}
			opts.scanFrequencies = append(opts.scanFrequencies, frequency)
		}
		return nil
	})
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
	voice, err := newChannelizerWithRFCutoff(opts.sampleRate, opts.audioRate, opts.voice-opts.center, opts.rfCutoffHz, opts.squelch)
	if err != nil {
		return err
	}
	slotBRate := opts.audioRate
	if opts.slotB == opts.dsc {
		slotBRate = 24_000
	}
	dsc, err := newChannelizerWithRFCutoff(opts.sampleRate, slotBRate, opts.slotB-opts.center, opts.rfCutoffHz, 0)
	if err != nil {
		return err
	}
	buffer := make([]byte, 1024*1024)
	var bytesRead, edgeBytes int64
	var dspTime time.Duration
	started := time.Now()
	for {
		count, readErr := input.Read(buffer)
		if count > 0 {
			count -= count % 2
			edgeBytes += countIQEdgeBytes(buffer[:count])
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
	result := report{IQSamples: samples, ElapsedSeconds: elapsed, SamplesPerSecond: float64(samples) / elapsed, RealTimeRatio: (float64(samples) / elapsed) / float64(opts.sampleRate), DSPSeconds: dspTime.Seconds(), DSPHeadroomRatio: (float64(samples) / float64(opts.sampleRate)) / dspTime.Seconds(), VoiceAudioSamples: voice.outputSamples, DSCAudioSamples: dsc.outputSamples, VoiceLevel: voice.level, DSCLevel: dsc.level, VoiceCarrierHz: voice.carrierOffsetHz(), DSCCarrierHz: dsc.carrierOffsetHz(), IQEdgeFraction: float64(edgeBytes) / float64(bytesRead), DSPChecksum: voice.checksum + dsc.checksum}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func runStream(opts options) error {
	voice, err := newChannelizerWithRFCutoff(opts.sampleRate, opts.audioRate, opts.voice-opts.center, opts.rfCutoffHz, opts.squelch)
	if err != nil {
		return err
	}
	dsc, err := newChannelizerWithRFCutoff(opts.sampleRate, 24_000, opts.dsc-opts.center, opts.rfCutoffHz, 0)
	if err != nil {
		return err
	}
	var slotB *channelizer
	if opts.slotB != opts.dsc {
		slotB, err = newChannelizerWithRFCutoff(opts.sampleRate, opts.audioRate, opts.slotB-opts.center, opts.rfCutoffHz, opts.squelch)
		if err != nil {
			return err
		}
	}
	spectrum := newSpectrumScanner(opts.sampleRate, opts.center, opts.scanFrequencies)
	widebandRing := newIQRing(opts.sampleRate, 5)
	backfillJobs := make(chan backfillJob, 2)
	go runBackfillWorker(backfillJobs, os.Stdout)
	enqueueBackfill := func(slot byte, frequency int) {
		iqSnapshot, startedAt := widebandRing.snapshot()
		if len(iqSnapshot) == 0 {
			return
		}
		job := backfillJob{slot: slot, frequency: frequency, center: opts.center,
			sampleRate: opts.sampleRate, audioRate: opts.audioRate, rfCutoffHz: opts.rfCutoffHz,
			squelch: opts.squelch, iq: iqSnapshot, startedAt: startedAt}
		select {
		case backfillJobs <- job:
		default:
			select {
			case <-backfillJobs:
			default:
			}
			backfillJobs <- job
		}
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
	tunes := make(chan tuneRequest, 2)
	go readControls(os.Stdin, tunes)
	buffer := make([]byte, 1024*1024)
	var iqBytes, edgeBytes int64
	lastState := time.Time{}
	for {
		select {
		case request := <-tunes:
			if request.slot == "B" {
				opts.slotB = request.frequency
				if request.frequency == opts.dsc {
					slotB = nil
				} else if slotB == nil {
					slotB, err = newChannelizerWithRFCutoff(opts.sampleRate, opts.audioRate, request.frequency-opts.center, opts.rfCutoffHz, opts.squelch)
					if err != nil {
						return err
					}
				} else {
					slotB.tune(request.frequency - opts.center)
				}
				if request.frequency != opts.dsc {
					enqueueBackfill(frameVoiceBBackfill, request.frequency)
				}
			} else {
				voice.tune(request.frequency - opts.center)
				opts.voice = request.frequency
				enqueueBackfill(frameVoiceBackfill, request.frequency)
			}
		default:
		}
		count, readErr := iq.Read(buffer)
		if count > 0 {
			count -= count % 2
			widebandRing.append(buffer[:count])
			iqBytes += int64(count)
			edgeBytes += countIQEdgeBytes(buffer[:count])
			voicePCM, slotBPCM, dscPCM := processReceivers(voice, slotB, dsc, spectrum, buffer[:count])
			if err := writeVoiceFrame(os.Stdout, voicePCM, voice.level); err != nil {
				_ = command.Process.Kill()
				return err
			}
			if slotB != nil {
				err = writeVoiceBFrame(os.Stdout, slotBPCM, slotB.level)
				if err != nil {
					_ = command.Process.Kill()
					return err
				}
			}
			err = writePCMFrame(os.Stdout, frameDSC, dscPCM)
			if err != nil {
				_ = command.Process.Kill()
				return err
			}
			if time.Since(lastState) >= time.Second {
				slotBLevel, slotBCarrier := dsc.level, dsc.carrierOffsetHz()
				if slotB != nil {
					slotBLevel, slotBCarrier = slotB.level, slotB.carrierOffsetHz()
				}
				state, _ := json.Marshal(map[string]any{"voice_frequency_hz": opts.voice, "voice_level": voice.level, "voice_carrier_offset_hz": voice.carrierOffsetHz(), "slot_b_frequency_hz": opts.slotB, "slot_b_level": slotBLevel, "slot_b_carrier_offset_hz": slotBCarrier, "dsc_level": dsc.level, "spectrum_activity": spectrum.snapshot(), "iq_edge_fraction": float64(edgeBytes) / float64(iqBytes), "iq_samples": iqBytes / 2})
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

func runBackfillWorker(jobs <-chan backfillJob, output io.Writer) {
	for job := range jobs {
		channel, err := newChannelizerWithRFCutoff(job.sampleRate, job.audioRate, job.frequency-job.center, job.rfCutoffHz, job.squelch)
		if err != nil {
			continue
		}
		sliceBytes := job.sampleRate * 2 / 50
		if sliceBytes < 2 {
			continue
		}
		var pcm []int16
		spans := make([]backfillSpan, 0, (len(job.iq)+sliceBytes-1)/sliceBytes)
		for offset := 0; offset+1 < len(job.iq); offset += sliceBytes {
			end := min(len(job.iq), offset+sliceBytes)
			end -= (end - offset) % 2
			if end <= offset {
				continue
			}
			part := channel.process(job.iq[offset:end])
			partBytes := uint32(len(part) * 2)
			if partBytes == 0 {
				continue
			}
			spans = append(spans, backfillSpan{byteCount: partBytes, noise: channel.level})
			pcm = append(pcm, part...)
		}
		kind := frameVoiceSpansBackfill
		if job.slot == frameVoiceBBackfill || job.slot == frameVoiceBSpansBackfill {
			kind = frameVoiceBSpansBackfill
		}
		_ = writeSpannedBackfillFrame(output, kind, job.startedAt, job.frequency, spans, pcm)
	}
}

func countIQEdgeBytes(iq []byte) int64 {
	var count int64
	for _, value := range iq {
		if value <= 3 || value >= 252 {
			count++
		}
	}
	return count
}

func processBoth(voice, dsc *channelizer, chunk []byte) (voicePCM, dscPCM []int16) {
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); voicePCM = voice.process(chunk) }()
	go func() { defer workers.Done(); dscPCM = dsc.process(chunk) }()
	workers.Wait()
	return
}

func processReceivers(voice, slotB, dsc *channelizer, spectrum *spectrumScanner, chunk []byte) (voicePCM, slotBPCM, dscPCM []int16) {
	var workers sync.WaitGroup
	workers.Add(3)
	go func() { defer workers.Done(); voicePCM = voice.process(chunk) }()
	go func() { defer workers.Done(); dscPCM = dsc.process(chunk) }()
	go func() { defer workers.Done(); spectrum.process(chunk) }()
	if slotB != nil {
		workers.Add(1)
		go func() { defer workers.Done(); slotBPCM = slotB.process(chunk) }()
	}
	workers.Wait()
	return
}

type tuneRequest struct {
	slot      string
	frequency int
}

func readControls(input io.Reader, tunes chan tuneRequest) {
	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || (fields[0] != "tune" && fields[0] != "tune-b") {
			continue
		}
		frequency, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		request := tuneRequest{slot: "A", frequency: frequency}
		if fields[0] == "tune-b" {
			request.slot = "B"
		}
		select {
		case tunes <- request:
		default:
			select {
			case <-tunes:
			default:
			}
			tunes <- request
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
func writeBackfillFrame(output io.Writer, kind byte, startedAt int64, frequency int, samples []int16, discriminatorNoise float64) error {
	payload := make([]byte, 24+len(samples)*2)
	binary.LittleEndian.PutUint64(payload[0:8], uint64(startedAt))
	binary.LittleEndian.PutUint64(payload[8:16], uint64(frequency))
	binary.LittleEndian.PutUint64(payload[16:24], math.Float64bits(discriminatorNoise))
	for index, sample := range samples {
		binary.LittleEndian.PutUint16(payload[24+index*2:], uint16(sample))
	}
	return writeFrame(output, kind, payload)
}
func writeSpannedBackfillFrame(output io.Writer, kind byte, startedAt int64, frequency int, spans []backfillSpan, samples []int16) error {
	const fixedBytes = 20
	payload := make([]byte, fixedBytes+len(spans)*12+len(samples)*2)
	binary.LittleEndian.PutUint64(payload[0:8], uint64(startedAt))
	binary.LittleEndian.PutUint64(payload[8:16], uint64(frequency))
	binary.LittleEndian.PutUint32(payload[16:20], uint32(len(spans)))
	offset := fixedBytes
	for _, span := range spans {
		binary.LittleEndian.PutUint32(payload[offset:offset+4], span.byteCount)
		binary.LittleEndian.PutUint64(payload[offset+4:offset+12], math.Float64bits(span.noise))
		offset += 12
	}
	for _, sample := range samples {
		binary.LittleEndian.PutUint16(payload[offset:], uint16(sample))
		offset += 2
	}
	return writeFrame(output, kind, payload)
}
func writeFrame(output io.Writer, kind byte, payload []byte) error {
	frameWriteMutex.Lock()
	defer frameWriteMutex.Unlock()
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
