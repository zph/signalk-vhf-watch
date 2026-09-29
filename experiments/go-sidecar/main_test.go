package main

import (
	"bytes"
	"encoding/binary"
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

func TestDefaultSquelchMutesUncorrelatedIQNoise(t *testing.T) {
	channel, err := newChannelizer(2_400_000, 16_000, 50_000, 20)
	if err != nil {
		t.Fatal(err)
	}
	iq := make([]byte, 2_400_000/5*2)
	state := uint32(1)
	for index := range iq {
		state = state*1664525 + 1013904223
		iq[index] = byte(state >> 24)
	}
	pcm := channel.process(iq)
	for index, sample := range pcm {
		if sample != 0 {
			t.Fatalf("noise sample %d was not squelched: %d (discriminator noise %.3f)", index, sample, channel.level)
		}
	}
}
