//go:build !arm64

package main

func firDotKernel(window, pairCoefficients []float64) (outputI, outputQ float64) {
	return firDotScalar(window, pairCoefficients)
}
