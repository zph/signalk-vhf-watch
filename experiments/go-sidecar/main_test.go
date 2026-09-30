package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"strings"
	"testing"
)

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
