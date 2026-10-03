package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"strings"
	"testing"
)

type directFIRDecimator struct {
	coefficients []float64
	historyI     []float64
	historyQ     []float64
	writeIndex   int
	decimation   int
	count        int
}

func newDirectFIRDecimator(coefficients []float64, decimation int) *directFIRDecimator {
	return &directFIRDecimator{
		coefficients: coefficients,
		historyI:     make([]float64, len(coefficients)),
		historyQ:     make([]float64, len(coefficients)),
		decimation:   decimation,
	}
}

// originalLowpassCoefficients retains the original per-tap coefficient evaluation and
// normalization for comparisons against the pre-optimization direct convolution.
func originalLowpassCoefficients(sampleRate, cutoffHz, taps int) []float64 {
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

func (f *directFIRDecimator) reset() {
	clear(f.historyI)
	clear(f.historyQ)
	f.writeIndex, f.count = 0, 0
}

// push preserves the original newest-to-oldest direct convolution as a numerical reference.
func (f *directFIRDecimator) push(inputI, inputQ float64) (outputI, outputQ float64, ready bool) {
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

func processWithDirectFIR(c *channelizer, firstRF, channelRF *directFIRDecimator, iq []byte) []int16 {
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
		firstI, firstQ, ready := firstRF.push(mixedI, mixedQ)
		if !ready {
			continue
		}
		filteredI, filteredQ, ready := channelRF.push(firstI, firstQ)
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
		output = append(output, softLimitAudio(c.deemphasis))
	}
	return output
}

func TestSymmetricFIRMatchesDirectConvolutionAcrossWrapsAndResets(t *testing.T) {
	for _, config := range []struct {
		taps, decimation int
	}{{3, 1}, {63, 1}, {63, 7}, {511, 5}, {511, 64}} {
		filter := newComplexFIRDecimator(480_000, 9_000, config.taps, config.decimation)
		direct := newDirectFIRDecimator(originalLowpassCoefficients(480_000, 9_000, config.taps), config.decimation)
		for left, right := 0, len(filter.coefficients)-1; left < right; left, right = left+1, right-1 {
			if filter.coefficients[left] != filter.coefficients[right] {
				t.Fatalf("%d-tap coefficients %d and %d are not symmetric", config.taps, left, right)
			}
		}
		seed := uint32(0x5eed)
		for sample := 0; sample < 20_000; sample++ {
			if sample == 7_777 {
				filter.reset()
				direct.reset()
			}
			seed = seed*1664525 + 1013904223
			inputI := (float64(seed>>8)/float64(1<<24))*2 - 1
			seed = seed*1664525 + 1013904223
			inputQ := (float64(seed>>8)/float64(1<<24))*2 - 1
			gotI, gotQ, gotReady := filter.push(inputI, inputQ)
			wantI, wantQ, wantReady := direct.push(inputI, inputQ)
			if gotReady != wantReady {
				t.Fatalf("%d-tap decimator readiness at sample %d = %v, want %v", config.taps, sample, gotReady, wantReady)
			}
			if gotReady && (math.Abs(gotI-wantI) > 2e-14 || math.Abs(gotQ-wantQ) > 2e-14) {
				t.Fatalf("%d-tap output at sample %d differs: got (%0.17g, %0.17g), direct (%0.17g, %0.17g)", config.taps, sample, gotI, gotQ, wantI, wantQ)
			}
		}
	}
}

func TestChannelizerPcmMatchesDirectFIRWithinOneLsb(t *testing.T) {
	const inputRate, inputSamples = 2_400_000, 96_000
	optimized, err := newChannelizer(inputRate, 16_000, 50_000)
	if err != nil {
		t.Fatal(err)
	}
	reference := *optimized
	firstRF := newDirectFIRDecimator(originalLowpassCoefficients(inputRate, 120_000, 63), optimized.firstRF.decimation)
	channelRF := newDirectFIRDecimator(originalLowpassCoefficients(480_000, 9_000, 511), optimized.channelRF.decimation)
	iq := make([]byte, inputSamples*2)
	var phase float64
	for sample := 0; sample < inputSamples; sample++ {
		modulation := 1_500 * math.Sin(2*math.Pi*1_000*float64(sample)/inputRate)
		phase += 2 * math.Pi * (50_000 + modulation) / inputRate
		iq[2*sample] = byte(math.Round(127.5 + 64*math.Cos(phase)))
		iq[2*sample+1] = byte(math.Round(127.5 + 64*math.Sin(phase)))
	}
	got := optimized.process(iq)
	want := processWithDirectFIR(&reference, firstRF, channelRF, iq)
	if len(got) != len(want) {
		t.Fatalf("PCM length = %d, direct convolution length = %d", len(got), len(want))
	}
	for index := range got {
		difference := int(got[index]) - int(want[index])
		if difference < -1 || difference > 1 {
			t.Fatalf("PCM sample %d = %d, direct convolution = %d (difference %d LSB)", index, got[index], want[index], difference)
		}
	}
}

func BenchmarkComplexFIRDecimator(b *testing.B) {
	const taps, decimation, samples = 511, 5, 4096
	optimized := newComplexFIRDecimator(480_000, 9_000, taps, decimation)
	direct := newDirectFIRDecimator(originalLowpassCoefficients(480_000, 9_000, taps), decimation)
	inputsI, inputsQ := make([]float64, samples), make([]float64, samples)
	seed := uint32(42)
	for index := range inputsI {
		seed = seed*1664525 + 1013904223
		inputsI[index] = float64(int32(seed)) / math.MaxInt32
		seed = seed*1664525 + 1013904223
		inputsQ[index] = float64(int32(seed)) / math.MaxInt32
	}
	b.Run("paired", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			optimized.push(inputsI[index%samples], inputsQ[index%samples])
		}
	})
	b.Run("direct", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			direct.push(inputsI[index%samples], inputsQ[index%samples])
		}
	})
}

func TestChannelizersProduceExpectedAudioRates(t *testing.T) {
	const inputRate = 2_400_000
	const durationSamples = inputRate / 10
	iq := make([]byte, durationSamples*2)
	for index := range iq {
		iq[index] = 128
	}
	voice, err := newChannelizer(inputRate, 16_000, 50_000)
	if err != nil {
		t.Fatal(err)
	}
	dsc, err := newChannelizer(inputRate, 24_000, -225_000)
	if err != nil {
		t.Fatal(err)
	}
	voice.process(iq)
	dsc.process(iq)
	if voice.outputSamples != 1_600 {
		t.Fatalf("voice samples = %d, want 1600", voice.outputSamples)
	}
	if dsc.outputSamples != 2_400 {
		t.Fatalf("DSC samples = %d, want 2400", dsc.outputSamples)
	}
}

func TestWritesFramedLittleEndianPCM(t *testing.T) {
	var output bytes.Buffer
	if err := writePCMFrame(&output, frameVoice, []int16{-1, 0x1234}); err != nil {
		t.Fatal(err)
	}
	written := output.Bytes()
	if written[0] != frameVoice || binary.LittleEndian.Uint32(written[1:5]) != 4 {
		t.Fatalf("bad frame header: %v", written[:5])
	}
	if !bytes.Equal(written[5:], []byte{0xff, 0xff, 0x34, 0x12}) {
		t.Fatalf("bad PCM payload: %v", written[5:])
	}
}

func TestWritesVoiceQualityWithUnsquelchedPCM(t *testing.T) {
	var output bytes.Buffer
	if err := writeVoiceFrame(&output, []int16{-2, 3}, 0.425); err != nil {
		t.Fatal(err)
	}
	written := output.Bytes()
	if written[0] != frameVoice || binary.LittleEndian.Uint32(written[1:5]) != 12 {
		t.Fatalf("bad voice frame header: %v", written[:5])
	}
	if quality := math.Float64frombits(binary.LittleEndian.Uint64(written[5:13])); quality != 0.425 {
		t.Fatalf("quality = %f", quality)
	}
	if !bytes.Equal(written[13:], []byte{0xfe, 0xff, 0x03, 0x00}) {
		t.Fatalf("bad voice PCM: %v", written[13:])
	}
}

func TestWritesIndependentSlotBVoiceFrame(t *testing.T) {
	var output bytes.Buffer
	if err := writeVoiceBFrame(&output, []int16{7}, 0.2); err != nil {
		t.Fatal(err)
	}
	if output.Bytes()[0] != frameVoiceB {
		t.Fatalf("frame kind = %d, want %d", output.Bytes()[0], frameVoiceB)
	}
}

func TestWritesTimestampedBackfillFrame(t *testing.T) {
	var output bytes.Buffer
	if err := writeBackfillFrame(&output, frameVoiceBBackfill, 1234, 156_425_000, []int16{-3, 9}, 0.12); err != nil {
		t.Fatal(err)
	}
	written := output.Bytes()
	if written[0] != frameVoiceBBackfill || binary.LittleEndian.Uint32(written[1:5]) != 28 {
		t.Fatalf("bad backfill header: %v", written[:5])
	}
	if timestamp := int64(binary.LittleEndian.Uint64(written[5:13])); timestamp != 1234 {
		t.Fatalf("timestamp = %d", timestamp)
	}
	if frequency := int(binary.LittleEndian.Uint64(written[13:21])); frequency != 156_425_000 {
		t.Fatalf("frequency = %d", frequency)
	}
}

func TestBackfillWorkerWritesPerSliceQualityWithOneChannelizer(t *testing.T) {
	const sampleRate = 960_000
	const sliceBytes = sampleRate * 2 / 50
	jobs := make(chan backfillJob, 1)
	jobs <- backfillJob{
		slot: frameVoiceBackfill, frequency: 156_800_000, center: 156_750_000,
		sampleRate: sampleRate, audioRate: 16_000, rfCutoffHz: 9_000, squelch: 20,
		iq: make([]byte, sliceBytes*2), startedAt: 1_234,
	}
	close(jobs)
	var output bytes.Buffer
	runBackfillWorker(jobs, &output)
	written := output.Bytes()
	if written[0] != frameVoiceSpansBackfill {
		t.Fatalf("frame kind = %d, want %d", written[0], frameVoiceSpansBackfill)
	}
	payload := written[5:]
	if int(binary.LittleEndian.Uint32(written[1:5])) != len(payload) || len(payload) < 20 {
		t.Fatalf("invalid framed payload length: header=%d actual=%d", binary.LittleEndian.Uint32(written[1:5]), len(payload))
	}
	if int64(binary.LittleEndian.Uint64(payload[:8])) != 1_234 || int(binary.LittleEndian.Uint64(payload[8:16])) != 156_800_000 {
		t.Fatalf("unexpected backfill identity: start=%d frequency=%d", int64(binary.LittleEndian.Uint64(payload[:8])), binary.LittleEndian.Uint64(payload[8:16]))
	}
	if count := binary.LittleEndian.Uint32(payload[16:20]); count != 2 {
		t.Fatalf("span count = %d, want 2", count)
	}
	offset := 20
	totalBytes := uint32(0)
	for span := 0; span < 2; span++ {
		byteCount := binary.LittleEndian.Uint32(payload[offset : offset+4])
		noise := math.Float64frombits(binary.LittleEndian.Uint64(payload[offset+4 : offset+12]))
		if byteCount != 640 || math.IsNaN(noise) || math.IsInf(noise, 0) {
			t.Fatalf("span %d = %d bytes, noise %v", span, byteCount, noise)
		}
		totalBytes += byteCount
		offset += 12
	}
	if totalBytes != uint32(len(payload)-offset) {
		t.Fatalf("span bytes = %d, PCM bytes = %d", totalBytes, len(payload)-offset)
	}
}

func TestIQRingRetainsOnlyTheLatestBoundedCapture(t *testing.T) {
	ring := newIQRing(4, 1)
	ring.append([]byte{1, 2, 3, 4, 5, 6})
	ring.append([]byte{7, 8, 9, 10, 11, 12})
	snapshot, _ := ring.snapshot()
	if !bytes.Equal(snapshot, []byte{5, 6, 7, 8, 9, 10, 11, 12}) {
		t.Fatalf("snapshot = %v", snapshot)
	}
}

func TestReadsIndependentSlotTuneCommands(t *testing.T) {
	tunes := make(chan tuneRequest, 2)
	readControls(strings.NewReader("tune 156800000\ntune-b 156425000\n"), tunes)
	first := <-tunes
	second := <-tunes
	if first.slot != "A" || first.frequency != 156800000 {
		t.Fatalf("first tune = %+v", first)
	}
	if second.slot != "B" || second.frequency != 156425000 {
		t.Fatalf("second tune = %+v", second)
	}
}

func TestAudioLimiterPreservesVoiceGainWithoutHardClipping(t *testing.T) {
	quiet := softLimitAudio(0.1)
	if quiet < 7_000 || quiet > 7_700 {
		t.Fatalf("small-signal sample = %d, want voice-range gain", quiet)
	}
	for _, sample := range []float64{-math.Pi, math.Pi} {
		limited := softLimitAudio(sample)
		if limited <= -32_760 || limited >= 32_760 {
			t.Fatalf("limited sample = %d, want headroom inside PCM clipping rails", limited)
		}
	}
}

func TestChannelFIRRejectsAnAdjacentMarineCarrier(t *testing.T) {
	response := func(frequencyHz float64) float64 {
		filter := newComplexFIRDecimator(480_000, 9_000, 511, 5)
		var phase, sumSquares float64
		var count int
		for index := 0; index < 30_000; index++ {
			phase += 2 * math.Pi * frequencyHz / 480_000
			i, q, ready := filter.push(math.Cos(phase), math.Sin(phase))
			if ready && index > 2_000 {
				sumSquares += i*i + q*q
				count++
			}
		}
		return math.Sqrt(sumSquares / float64(count))
	}
	passband := response(2_100)
	adjacent := response(25_000)
	if passband < 0.95 {
		t.Fatalf("2100 Hz passband response = %.4f, want >= 0.95", passband)
	}
	if ratio := adjacent / passband; ratio > 0.01 {
		t.Fatalf("25 kHz adjacent response ratio = %.6f, want <= 0.01", ratio)
	}
}

func TestPolarDiscriminatorIsAmplitudeInvariantAndTracksCarrierOffset(t *testing.T) {
	constant := func(amplitude func(int) float64) *channelizer {
		channel, err := newChannelizer(2_400_000, 16_000, 0)
		if err != nil {
			t.Fatal(err)
		}
		var phase float64
		for index := 0; index < channelRate*8; index++ {
			phase += 2 * math.Pi * 300 / channelRate
			magnitude := amplitude(index)
			channel.discriminate(magnitude*math.Cos(phase), magnitude*math.Sin(phase))
		}
		return channel
	}
	fixed := constant(func(int) float64 { return 1 })
	varying := constant(func(index int) float64 { return 0.2 + 0.8*float64(index%97)/96 })
	if difference := math.Abs(fixed.carrierOffsetHz() - varying.carrierOffsetHz()); difference > 1e-6 {
		t.Fatalf("amplitude changed carrier estimate by %.9f Hz", difference)
	}
	if offset := fixed.carrierOffsetHz(); offset < 290 || offset > 301 {
		t.Fatalf("tracked carrier offset = %.3f Hz, want approximately 300 Hz", offset)
	}
}

func TestCountsPotentialIQClippingAtConverterEdges(t *testing.T) {
	if count := countIQEdgeBytes([]byte{0, 1, 3, 4, 128, 251, 252, 254, 255}); count != 6 {
		t.Fatalf("edge count = %d, want 6", count)
	}
}

func TestSpectrumScannerFindsAnActiveChannelAcrossTheWidebandCapture(t *testing.T) {
	const sampleRate = 2_400_000
	const center = 156_750_000
	const active = 156_800_000
	const quiet = 156_425_000
	scanner := newSpectrumScanner(sampleRate, center, []int{active, quiet})
	iq := make([]byte, spectrumStride*4*2)
	seed := uint32(1)
	for sample := 0; sample < len(iq)/2; sample++ {
		seed = seed*1664525 + 1013904223
		noiseI := float64(int((seed>>24)&15)-7) * 0.8
		seed = seed*1664525 + 1013904223
		noiseQ := float64(int((seed>>24)&15)-7) * 0.8
		phase := 2 * math.Pi * float64(active-center) * float64(sample) / sampleRate
		iq[sample*2] = byte(math.Round(127.5 + 55*math.Cos(phase) + noiseI))
		iq[sample*2+1] = byte(math.Round(127.5 + 55*math.Sin(phase) + noiseQ))
	}
	scanner.process(iq)
	activity := scanner.snapshot()
	if activity["156800000"] < 1 {
		t.Fatalf("active score = %.3f, want a clear detection", activity["156800000"])
	}
	if activity["156800000"] <= activity["156425000"]*5 {
		t.Fatalf("active score %.3f did not separate from quiet score %.3f", activity["156800000"], activity["156425000"])
	}
}
