package vhfaudio

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
)

const maxFrameSize = 16 * 1024 * 1024

type Config struct {
	SampleRate   int
	Squelch      int
	AdaptiveHiss bool
}

type Processor struct {
	config Config
	voice  *voiceProcessor
	slotB  *voiceProcessor
}

func NewProcessor(config Config) (*Processor, error) {
	if config.SampleRate < 8_000 || config.SampleRate > 48_000 {
		return nil, fmt.Errorf("unsupported audio sample rate %d", config.SampleRate)
	}
	if config.Squelch < 0 || config.Squelch > 100 {
		return nil, fmt.Errorf("squelch must be between 0 and 100")
	}
	return &Processor{
		config: config,
		voice:  newVoiceProcessor(config),
		slotB:  newVoiceProcessor(config),
	}, nil
}

func (processor *Processor) ProcessFrame(kind byte, payload []byte) ([]byte, error) {
	var voice *voiceProcessor
	switch kind {
	case 1:
		voice = processor.voice
	case 4:
		voice = processor.slotB
	default:
		return payload, nil
	}
	if len(payload) < 8 || (len(payload)-8)%2 != 0 {
		return nil, fmt.Errorf("invalid voice frame length %d", len(payload))
	}
	noise := math.Float64frombits(binary.LittleEndian.Uint64(payload[:8]))
	if math.IsNaN(noise) || math.IsInf(noise, 0) || noise < 0 {
		return nil, fmt.Errorf("invalid discriminator noise %v", noise)
	}
	pcm := make([]int16, (len(payload)-8)/2)
	for index := range pcm {
		pcm[index] = int16(binary.LittleEndian.Uint16(payload[8+index*2:]))
	}
	cleaned := voice.process(pcm, noise)
	output := make([]byte, len(payload))
	copy(output[:8], payload[:8])
	for index, sample := range cleaned {
		binary.LittleEndian.PutUint16(output[8+index*2:], uint16(sample))
	}
	return output, nil
}

func (processor *Processor) Run(input io.Reader, output io.Writer) error {
	var header [5]byte
	for {
		_, err := io.ReadFull(input, header[:])
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		length := binary.LittleEndian.Uint32(header[1:])
		if length > maxFrameSize {
			return fmt.Errorf("frame exceeds %d bytes", maxFrameSize)
		}
		payload := make([]byte, length)
		if _, err = io.ReadFull(input, payload); err != nil {
			return err
		}
		cleaned, err := processor.ProcessFrame(header[0], payload)
		if err != nil {
			return err
		}
		if err = writeAll(output, header[:]); err != nil {
			return err
		}
		if err = writeAll(output, cleaned); err != nil {
			return err
		}
	}
}

func writeAll(output io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := output.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}

type voiceProcessor struct {
	gate         *discriminatorGate
	hiss         *spectralReducer
	delayedGains []float64
	samples      int
}

func newVoiceProcessor(config Config) *voiceProcessor {
	voice := &voiceProcessor{gate: newDiscriminatorGate(config.SampleRate, config.Squelch)}
	if config.AdaptiveHiss {
		voice.hiss = newSpectralReducer(config.SampleRate)
		voice.delayedGains = make([]float64, voice.hiss.latency+1)
	}
	return voice
}

func (voice *voiceProcessor) process(pcm []int16, noise float64) []int16 {
	gains := make([]float64, len(pcm))
	for index := range gains {
		gains[index] = voice.gate.gain(noise)
	}
	if voice.hiss != nil {
		pcm = voice.hiss.process(pcm)
	}
	output := make([]int16, len(pcm))
	for index, sample := range pcm {
		gain := gains[index]
		if voice.delayedGains != nil {
			voice.delayedGains[voice.samples%len(voice.delayedGains)] = gain
			gain = voice.delayedGains[(voice.samples+1)%len(voice.delayedGains)]
			voice.samples++
		}
		output[index] = clampSample(float64(sample) * gain)
	}
	return output
}

func clampSample(value float64) int16 {
	return int16(math.Round(math.Max(-32768, math.Min(32767, value))))
}

type discriminatorGate struct {
	level       int
	sampleRate  int
	open        bool
	openSamples int
	holdSamples int
	volume      float64
}

func newDiscriminatorGate(sampleRate, level int) *discriminatorGate {
	return &discriminatorGate{sampleRate: sampleRate, level: level}
}

func (gate *discriminatorGate) gain(noise float64) float64 {
	if gate.level == 0 {
		return 1
	}
	threshold := math.Max(0.04, 0.38-float64(gate.level)*0.008)
	if noise < threshold {
		gate.openSamples++
		if gate.openSamples >= gate.sampleRate/200 {
			gate.open = true
			gate.holdSamples = gate.sampleRate / 4
		}
	} else {
		gate.openSamples = 0
		if noise > threshold*1.2 {
			gate.open = false
		}
	}
	if !gate.open && gate.holdSamples > 0 {
		gate.holdSamples--
	}
	target := 0.0
	if gate.open || gate.holdSamples > 0 {
		target = 1
	}
	fade := 0.015
	if target > gate.volume {
		fade = 0.003
	}
	step := 1 / (float64(gate.sampleRate) * fade)
	gate.volume += math.Copysign(math.Min(math.Abs(target-gate.volume), step), target-gate.volume)
	return gate.volume
}
