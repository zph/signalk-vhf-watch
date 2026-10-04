package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"os"
	"sort"
	"strings"
	"testing"
)

// BenchmarkReceiverReplay reads one pre-captured CU8 fixture so baseline and optimized builds
// can process byte-identical input. Keep this file compatible with the pre-optimization
// main.go: rollout can copy it into an isolated baseline checkout without the new FIR files.
// The capture remains local to the Pi; logs contain hashes and aggregate output metrics only.
func BenchmarkReceiverReplay(b *testing.B) {
	fixture := os.Getenv("VHF_BENCH_IQ_PATH")
	if fixture == "" {
		b.Skip("set VHF_BENCH_IQ_PATH to a locally stored CU8 capture")
	}
	iq, err := os.ReadFile(fixture)
	if err != nil {
		b.Fatal(err)
	}
	if len(iq) == 0 || len(iq)%2 != 0 {
		b.Fatalf("CU8 fixture must contain complete non-empty I/Q pairs; bytes=%d", len(iq))
	}
	const sampleRate = 2_400_000
	if len(iq)/2%sampleRate != 0 {
		b.Fatalf("fixture duration must be a whole second at %d samples/sec; samples=%d", sampleRate, len(iq)/2)
	}
	fixtureHash := sha256.Sum256(iq)
	durationSeconds := len(iq) / 2 / sampleRate

	for _, scenario := range []struct {
		name                          string
		center, voice, secondary, dsc int
		slotB                         bool
		scan                          bool
	}{
		// The saved Pi configuration is fixed WX4 at 162.425 MHz; production processes
		// voice and 24 kHz DSC channelizers at the same center and an empty scanner.
		{name: "WX4_fixed_voice_plus_DSC", center: 162_425_000, voice: 162_425_000, secondary: 162_425_000, dsc: 162_425_000},
		// Cost-only variants reinterpret the WX4-centered bytes as wideband input. They measure
		// DSP work, not RF reception quality for these channels.
		{name: "wideband_A16_plus_DSC_plus_scanner45_cost_on_WX4_fixture", center: 156_750_000, voice: 156_800_000, secondary: 156_525_000, dsc: 156_525_000, scan: true},
		{name: "wideband_A16_B68_DSC_scanner45_cost_on_WX4_fixture", center: 156_750_000, voice: 156_800_000, secondary: 156_425_000, dsc: 156_525_000, slotB: true, scan: true},
	} {
		b.Run(scenario.name, func(b *testing.B) {
			b.StopTimer()
			b.ReportAllocs()
			b.SetBytes(int64(len(iq)))
			chunkCount := (len(iq) + 1024*1024 - 1) / (1024 * 1024)
			var voiceChunks, slotBChunks, dscChunks [][]int16
			var activity map[string]float64
			for iteration := 0; iteration < b.N; iteration++ {
				voice, err := newChannelizer(sampleRate, 16_000, scenario.voice-scenario.center)
				if err != nil {
					b.Fatal(err)
				}
				dsc, err := newChannelizer(sampleRate, 24_000, scenario.dsc-scenario.center)
				if err != nil {
					b.Fatal(err)
				}
				var slotB *channelizer
				if scenario.slotB {
					slotB, err = newChannelizer(sampleRate, 16_000, scenario.secondary-scenario.center)
					if err != nil {
						b.Fatal(err)
					}
				}
				var frequencies []int
				if scenario.scan {
					frequencies = benchmarkScanFrequencies()
				}
				scanner := newSpectrumScanner(sampleRate, scenario.center, frequencies)
				voiceChunks = make([][]int16, 0, chunkCount)
				dscChunks = make([][]int16, 0, chunkCount)
				slotBChunks = nil
				if slotB != nil {
					slotBChunks = make([][]int16, 0, chunkCount)
				}
				b.StartTimer()
				for offset := 0; offset < len(iq); offset += 1024 * 1024 {
					end := min(offset+1024*1024, len(iq))
					end -= (end - offset) % 2
					voicePCM, slotBPCM, dscPCM := processReceivers(voice, slotB, dsc, scanner, iq[offset:end])
					voiceChunks = append(voiceChunks, voicePCM)
					dscChunks = append(dscChunks, dscPCM)
					if slotB != nil {
						slotBChunks = append(slotBChunks, slotBPCM)
					}
				}
				b.StopTimer()
				activity = scanner.snapshot()
			}
			voicePCM := joinPCM(voiceChunks)
			slotBPCM := joinPCM(slotBChunks)
			dscPCM := joinPCM(dscChunks)
			wantVoiceSamples := durationSeconds * 16_000
			wantDSCSamples := durationSeconds * 24_000
			wantSlotBSamples := 0
			if scenario.slotB {
				wantSlotBSamples = durationSeconds * 16_000
			}
			if len(voicePCM) != wantVoiceSamples || len(dscPCM) != wantDSCSamples || len(slotBPCM) != wantSlotBSamples {
				b.Fatalf("unexpected PCM sample counts: voice=%d/%d slot_b=%d/%d dsc=%d/%d", len(voicePCM), wantVoiceSamples, len(slotBPCM), wantSlotBSamples, len(dscPCM), wantDSCSamples)
			}
			b.ReportMetric(float64(durationSeconds), "audio-s")
			b.Logf("fixture_sha256=%s bytes=%d seconds=%d voice_samples=%d slot_b_samples=%d dsc_samples=%d voice_pcm_sha256=%s slot_b_pcm_sha256=%s dsc_pcm_sha256=%s activity_channels=%d activity_sha256=%s",
				hex.EncodeToString(fixtureHash[:]), len(iq), durationSeconds,
				len(voicePCM), len(slotBPCM), len(dscPCM), pcmHash(voicePCM), pcmHash(slotBPCM), pcmHash(dscPCM),
				len(activity), activityHash(activity))
		})
	}
}

func benchmarkScanFrequencies() []int {
	// This mirrors nativeSidecarArgs' US_CA channelPlan filter and sort.
	frequencies := []int{
		156_050_000, 156_200_000, 156_250_000, 156_300_000, 156_350_000,
		156_400_000, 156_450_000, 156_500_000, 156_550_000, 156_600_000,
		156_650_000, 156_700_000, 156_750_000, 156_800_000, 156_850_000,
		156_900_000, 156_950_000, 157_000_000, 157_050_000, 157_100_000,
		157_150_000, 156_075_000, 156_125_000, 156_175_000, 156_225_000,
		156_275_000, 156_325_000, 156_375_000, 156_425_000, 156_475_000,
		156_575_000, 156_625_000, 156_675_000, 156_725_000, 156_775_000,
		156_825_000, 156_875_000, 156_925_000, 156_975_000, 157_025_000,
		157_075_000, 157_125_000, 157_175_000, 157_375_000, 157_425_000,
	}
	sort.Ints(frequencies)
	return frequencies
}

func pcmHash(samples []int16) string {
	if len(samples) == 0 {
		return "empty"
	}
	data := make([]byte, len(samples)*2)
	for index, sample := range samples {
		binary.LittleEndian.PutUint16(data[index*2:], uint16(sample))
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func joinPCM(chunks [][]int16) []int16 {
	var total int
	for _, chunk := range chunks {
		total += len(chunk)
	}
	result := make([]int16, 0, total)
	for _, chunk := range chunks {
		result = append(result, chunk...)
	}
	return result
}

func activityHash(activity map[string]float64) string {
	if len(activity) == 0 {
		return "empty"
	}
	keys := make([]string, 0, len(activity))
	for key := range activity {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var formatted strings.Builder
	for index, key := range keys {
		if index > 0 {
			formatted.WriteByte(',')
		}
		formatted.WriteString(key)
		formatted.WriteByte('=')
		var value [8]byte
		binary.LittleEndian.PutUint64(value[:], math.Float64bits(activity[key]))
		formatted.WriteString(hex.EncodeToString(value[:]))
	}
	hash := sha256.Sum256([]byte(formatted.String()))
	return hex.EncodeToString(hash[:])
}
