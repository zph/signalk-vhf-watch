package main

import (
	"flag"
	"fmt"
	"os"

	vhfaudio "github.com/zph/signalk-vhf-watch/go-sidecar"
)

func main() {
	sampleRate := flag.Int("audio-rate", 16_000, "PCM sample rate")
	squelch := flag.Int("squelch", 20, "voice squelch level, 0 to 100")
	hiss := flag.String("hiss", "off", "hiss reduction: off or adaptive")
	flag.Parse()
	if *hiss != "off" && *hiss != "adaptive" {
		fmt.Fprintln(os.Stderr, "hiss must be off or adaptive")
		os.Exit(2)
	}
	processor, err := vhfaudio.NewProcessor(vhfaudio.Config{
		SampleRate:   *sampleRate,
		Squelch:      *squelch,
		AdaptiveHiss: *hiss == "adaptive",
	})
	if err == nil {
		err = processor.Run(os.Stdin, os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
