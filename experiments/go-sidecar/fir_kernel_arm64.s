#include "textflag.h"

// firDotNEON processes interleaved float64 I/Q lanes for one complete symmetric FIR window.
// It uses fused vector multiply-add to match the existing Go scalar ring's FMADD arithmetic.
// FADD .2D is a raw word because Go1.26's assembler leaves that vector mnemonic unimplemented;
// its encoding was checked with clang and the linked ARM64 instructions decoded with otool.
//
// Vector registers: V0 accumulator [I,Q], V1 left sample pair, V2 right sample pair,
// V3 summed sample pair, and V4 broadcast coefficient.
TEXT ·firDotNEON(SB), NOSPLIT, $0-48
	MOVD left+0(FP), R0
	MOVD right+8(FP), R1
	MOVD pairCoefficients+16(FP), R2
	MOVD pairs+24(FP), R3
	MOVD $0, R4
	VEOR V0.B16, V0.B16, V0.B16

pair_loop:
	CMP R3, R4
	BGE pair_done
	VLD1.P 16(R0), [V1.D2]
	VLD1 (R1), [V2.D2]
	SUB $16, R1
	WORD $0x4e62d423 // FADD V3.2D, V1.2D, V2.2D
	MOVD (R2), R6
	VDUP R6, V4.D2
	VFMLA V4.D2, V3.D2, V0.D2
	ADD $8, R2
	ADD $1, R4
	B pair_loop

pair_done:
	VMOV V0.D[0], R5
	VMOV V0.D[1], R6
	MOVD R5, outputI+32(FP)
	MOVD R6, outputQ+40(FP)
	RET
