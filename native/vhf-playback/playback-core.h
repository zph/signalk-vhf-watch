#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <deque>
#include <vector>

namespace vhf {

class Denoiser {
 public:
  virtual ~Denoiser() = default;
  virtual size_t recommendedBlock() const = 0;
  virtual std::vector<float> run(const float *samples, size_t n) = 0;
  virtual std::vector<float> flush() = 0;
};

class PlaybackCore {
 public:
  using Sink = std::function<void(const int16_t *, size_t)>;
  explicit PlaybackCore(Denoiser &denoiser, Sink sink);
  void accept(const int16_t *pcm, size_t n, float discriminatorNoise);
  void finish();
  uint64_t inputSamples() const { return received_; }
  uint64_t outputSamples() const { return written_; }
  size_t maxQueuedSamples() const { return maxQueuedSamples_; }

 private:
  struct Feature {
    uint64_t index;
    float level, ratio;
    bool allKnown, rfClose, allUnknown;
  };
  struct NoiseTemplate {
    uint64_t index;
    float ratio, q75;
    bool valid;
  };
  void appendDenoised(const std::vector<float> &samples);
  void makeFeatures();
  void finalizeReady();
  void classifyFrame(uint64_t frame, bool open);
  void scheduleOpen(uint64_t frame);
  void setGain(uint64_t index, float value);
  void pump(bool eof);
  void emitLimited(bool eof);
  void prune();
  void trackQueues();
  const Feature *feature(int64_t index) const;
  const NoiseTemplate *templateFor(uint64_t index) const;
  NoiseTemplate makeTemplate(uint64_t index) const;
  float smoothedRatio(uint64_t index) const;
  float smoothedLevel(uint64_t index) const;
  bool candidate(uint64_t index) const;
  float rawAt(uint64_t index) const;
  float rfAt(uint64_t index) const;

  Denoiser &denoiser_;
  Sink sink_;
  uint64_t received_ = 0, generated_ = 0, written_ = 0;
  uint64_t rawBase_ = 0, gainBase_ = 0, nextFeature_ = 0, finalized_ = 0;
  uint64_t candidateRun_ = 0;
  size_t maxQueuedSamples_ = 0;
  float limiterGain_ = 1.0f;
  std::deque<float> denoised_, limited_;
  std::deque<float> raw_, rf_, gain_;
  std::deque<Feature> features_;
  std::deque<NoiseTemplate> templates_;
};

}  // namespace vhf
