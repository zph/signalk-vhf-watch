package vhfaudio

import (
	"bytes"
	"encoding/binary"
	"math"
	"testing"
)

func voiceFrame(noise float64, samples []int16) []byte {
	payload := make([]byte, 8+len(samples)*2)
	binary.LittleEndian.PutUint64(payload, math.Float64bits(noise))
	for index, sample := range samples {
		binary.LittleEndian.PutUint16(payload[8+index*2:], uint16(sample))
	}
	return payload
}

func frame(kind byte, payload []byte) []byte {
	result := make([]byte, 5+len(payload))
	result[0] = kind
	binary.LittleEndian.PutUint32(result[1:], uint32(len(payload)))
	copy(result[5:], payload)
	return result
}

func TestGateUsesCarrierQuietingAndHang(t *testing.T) {
	processor, err := NewProcessor(Config{SampleRate: 16_000, Squelch: 20})
	if err != nil {
		t.Fatal(err)
	}
	samples := make([]int16, 1_600)
	for index := range samples {
		samples[index] = 2_000
	}
	idle, err := processor.ProcessFrame(1, voiceFrame(0.33, samples))
	if err != nil {
		t.Fatal(err)
	}
	if binary.LittleEndian.Uint16(idle[8+1_000*2:]) != 0 {
		t.Fatal("idle static passed squelch")
	}
	carrier, err := processor.ProcessFrame(1, voiceFrame(0.05, samples))
	if err != nil {
		t.Fatal(err)
	}
	if int16(binary.LittleEndian.Uint16(carrier[8+1_000*2:])) < 1_900 {
		t.Fatal("carrier did not open squelch")
	}
	hung, _ := processor.ProcessFrame(1, voiceFrame(0.33, samples))
	if int16(binary.LittleEndian.Uint16(hung[8+1_000*2:])) < 1_900 {
		t.Fatal("short noise gap lost the transmission")
	}
	for range 4 {
		hung, _ = processor.ProcessFrame(1, voiceFrame(0.33, samples))
	}
	if binary.LittleEndian.Uint16(hung[8+1_000*2:]) != 0 {
		t.Fatal("squelch did not close after hang")
	}
}

func TestFrameProtocolPreservesDSCAndMetadata(t *testing.T) {
	processor, err := NewProcessor(Config{SampleRate: 16_000, Squelch: 0})
	if err != nil {
		t.Fatal(err)
	}
	voice := voiceFrame(0.05, []int16{1_000, -2_000})
	dsc := []byte{1, 2, 3, 4}
	input := append(frame(1, voice), frame(2, dsc)...)
	var output bytes.Buffer
	if err := processor.Run(bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), input) {
		t.Fatal("raw voice or DSC frame changed")
	}
	if _, err := processor.ProcessFrame(1, []byte{1}); err == nil {
		t.Fatal("accepted malformed voice frame")
	}
}

func TestSeparateVoiceSlots(t *testing.T) {
	processor, err := NewProcessor(Config{SampleRate: 16_000, Squelch: 20})
	if err != nil {
		t.Fatal(err)
	}
	samples := make([]int16, 1_600)
	for index := range samples {
		samples[index] = 2_000
	}
	if _, err := processor.ProcessFrame(1, voiceFrame(0.05, samples)); err != nil {
		t.Fatal(err)
	}
	slotB, err := processor.ProcessFrame(4, voiceFrame(0.33, samples))
	if err != nil {
		t.Fatal(err)
	}
	if binary.LittleEndian.Uint16(slotB[8+1_000*2:]) != 0 {
		t.Fatal("slot B inherited slot A squelch state")
	}
}
