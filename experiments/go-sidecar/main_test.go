package main

import (
	"bytes"
	"encoding/binary"
	"math"
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
