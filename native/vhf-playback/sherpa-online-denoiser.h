/*
 * Minimal declarations copied from the Sherpa-ONNX 1.13.8 C API.
 * Upstream: https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8
 * Copyright (c) 2021 Xiaomi Corporation. Licensed under Apache-2.0.
 * Keep these layouts and declarations synchronized with sherpa-onnx/c-api/c-api.h.
 */
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SherpaOnnxOfflineSpeechDenoiserGtcrnModelConfig {
  const char *model;
} SherpaOnnxOfflineSpeechDenoiserGtcrnModelConfig;

typedef struct SherpaOnnxOfflineSpeechDenoiserDpdfNetModelConfig {
  const char *model;
  float attenuation_limit_db;
} SherpaOnnxOfflineSpeechDenoiserDpdfNetModelConfig;

typedef struct SherpaOnnxOfflineSpeechDenoiserModelConfig {
  SherpaOnnxOfflineSpeechDenoiserGtcrnModelConfig gtcrn;
  int32_t num_threads;
  int32_t debug;
  const char *provider;
  SherpaOnnxOfflineSpeechDenoiserDpdfNetModelConfig dpdfnet;
} SherpaOnnxOfflineSpeechDenoiserModelConfig;

typedef struct SherpaOnnxOnlineSpeechDenoiserConfig {
  SherpaOnnxOfflineSpeechDenoiserModelConfig model;
} SherpaOnnxOnlineSpeechDenoiserConfig;

typedef struct SherpaOnnxOnlineSpeechDenoiser SherpaOnnxOnlineSpeechDenoiser;
typedef struct SherpaOnnxDenoisedAudio {
  const float *samples;
  int32_t n;
  int32_t sample_rate;
} SherpaOnnxDenoisedAudio;

const SherpaOnnxOnlineSpeechDenoiser *SherpaOnnxCreateOnlineSpeechDenoiser(
    const SherpaOnnxOnlineSpeechDenoiserConfig *config);
void SherpaOnnxDestroyOnlineSpeechDenoiser(const SherpaOnnxOnlineSpeechDenoiser *sd);
int32_t SherpaOnnxOnlineSpeechDenoiserGetSampleRate(const SherpaOnnxOnlineSpeechDenoiser *sd);
int32_t SherpaOnnxOnlineSpeechDenoiserGetFrameShiftInSamples(const SherpaOnnxOnlineSpeechDenoiser *sd);
const SherpaOnnxDenoisedAudio *SherpaOnnxOnlineSpeechDenoiserRun(
    const SherpaOnnxOnlineSpeechDenoiser *sd, const float *samples, int32_t n,
    int32_t sample_rate);
const SherpaOnnxDenoisedAudio *SherpaOnnxOnlineSpeechDenoiserFlush(
    const SherpaOnnxOnlineSpeechDenoiser *sd);
void SherpaOnnxDestroyDenoisedAudio(const SherpaOnnxDenoisedAudio *audio);

#ifdef __cplusplus
}
#endif
