//go:build arm64

package main

//go:noescape
func firDotNEON(left, right, pairCoefficients *float64, pairs int) (outputI, outputQ float64)

func firDotKernel(window, pairCoefficients []float64) (outputI, outputQ float64) {
	return firDotNEON(&window[0], &window[len(window)-2], &pairCoefficients[0], len(pairCoefficients))
}
