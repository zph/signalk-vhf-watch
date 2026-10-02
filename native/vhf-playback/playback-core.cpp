#include "playback-core.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <utility>

namespace vhf {
namespace {
constexpr uint64_t kRate = 16000, kHop = 160, kWindow = 320;
constexpr uint64_t kPreroll = 2400, kAttack = 240, kHold = 6400;
constexpr uint64_t kRelease = 3200, kGateLookahead = 6400, kLimiterLookahead = 80;
constexpr size_t kMaxRawRing = 20000;
constexpr size_t kFeatureHistory = 2000;
constexpr size_t kMaxGainRing = 20000;
constexpr float kFloor = 0.0562341325f;
constexpr float kFixedGain = 3.758374f;
constexpr float kPeakLimit = 0.891250938f;

const std::array<float, kWindow> &hann() {
  static const auto result = [] {
    std::array<float, kWindow> w{};
    for (size_t i = 0; i < kWindow; ++i)
      w[i] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * M_PI * i / (kWindow - 1)));
    return w;
  }();
  return result;
}

float bandPower(const float *samples, double frequency) {
  const double coefficient = 2.0 * std::cos(2.0 * M_PI * frequency / kRate);
  double s1 = 0.0, s2 = 0.0;
  for (size_t i = 0; i < kWindow; ++i) {
    const double s0 = samples[i] * hann()[i] + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return static_cast<float>(std::max(0.0, s1 * s1 + s2 * s2 - coefficient * s1 * s2));
}

float median(std::vector<float> values) {
  if (values.empty()) return 0.0f;
  const size_t mid = values.size() / 2;
  std::nth_element(values.begin(), values.begin() + mid, values.end());
  const float upper = values[mid];
  if (values.size() & 1u) return upper;
  std::nth_element(values.begin(), values.begin() + mid - 1, values.begin() + mid);
  return 0.5f * (values[mid - 1] + upper);
}

float quantile(std::vector<float> values, float q) {
  if (values.empty()) return 0.0f;
  const size_t index = static_cast<size_t>(q * (values.size() - 1));
  std::nth_element(values.begin(), values.begin() + index, values.end());
  return values[index];
}
}  // namespace

PlaybackCore::PlaybackCore(Denoiser &denoiser, Sink sink)
    : denoiser_(denoiser), sink_(std::move(sink)) {
  if (!sink_) throw std::invalid_argument("PCM output sink is required");
}

float PlaybackCore::rawAt(uint64_t index) const {
  if (index < rawBase_ || index >= received_)
    throw std::runtime_error("raw sample history underflow");
  return raw_[static_cast<size_t>(index - rawBase_)];
}

float PlaybackCore::rfAt(uint64_t index) const {
  if (index < rawBase_ || index >= received_)
    throw std::runtime_error("RF sample history underflow");
  return rf_[static_cast<size_t>(index - rawBase_)];
}

void PlaybackCore::accept(const int16_t *pcm, size_t n, float noise) {
  if (!pcm || n == 0 || n > 1024) throw std::invalid_argument("input block must contain 1..1024 samples");
  if (raw_.size() + n > kMaxRawRing)
    throw std::runtime_error("native playback source ring exceeded its bound");

  for (size_t i = 0; i < n; ++i) {
    const float sample = static_cast<float>(pcm[i]) / 32768.0f;
    raw_.push_back(sample);
    rf_.push_back(noise);
    setGain(received_ + i, kFloor);
  }
  if (received_ == 0) {
    const size_t first = static_cast<size_t>(std::min<uint64_t>(n, kPreroll));
    for (size_t i = 0; i < first; ++i) setGain(i, 1.0f);
    const size_t tail = static_cast<size_t>(std::min<uint64_t>(n, kPreroll + kRelease));
    for (size_t i = static_cast<size_t>(std::min<uint64_t>(n, kPreroll)); i < tail; ++i) {
      const float t = static_cast<float>(i - kPreroll + 1) / kRelease;
      setGain(i, kFloor + (1.0f - kFloor) * (0.5f + 0.5f * std::cos(M_PI * t)));
    }
  }
  received_ += n;
  trackQueues();

  // Internal subblocks are fixed and bounded, independent of IPC record or read partitions.
  const size_t recommended = denoiser_.recommendedBlock();
  if (recommended == 0 || recommended > 1024)
    throw std::runtime_error("denoiser returned an invalid frame hop");
  size_t offset = 0;
  while (offset < n) {
    const size_t count = std::min(recommended, n - offset);
    std::array<float, 1024> input{};
    for (size_t i = 0; i < count; ++i) input[i] = static_cast<float>(pcm[offset + i]) / 32768.0f;
    appendDenoised(denoiser_.run(input.data(), count));
    offset += count;
  }
  makeFeatures();
  pump(false);
  trackQueues();
}

void PlaybackCore::appendDenoised(const std::vector<float> &samples) {
  const size_t remaining = static_cast<size_t>(received_ - generated_);
  if (samples.size() > remaining)
    throw std::runtime_error("denoiser generated more samples than the source");
  denoised_.insert(denoised_.end(), samples.begin(), samples.end());
  generated_ += samples.size();
  trackQueues();
}

void PlaybackCore::makeFeatures() {
  // Frame centers use absolute source indices at 0, 160, 320, ... . The first
  // half-window before sample zero is zero padded; the EOF tail stays uncertain.
  while (nextFeature_ * kHop + kWindow / 2 <= received_) {
    const int64_t center = static_cast<int64_t>(nextFeature_ * kHop);
    std::array<float, kWindow> frame{};
    double energy = 0.0, weight = 0.0;
    bool allKnown = true, rfClose = true, allUnknown = true;
    for (size_t i = 0; i < kWindow; ++i) {
      const int64_t index = center - static_cast<int64_t>(kWindow / 2) + static_cast<int64_t>(i);
      float x = 0.0f;
      if (index >= 0 && static_cast<uint64_t>(index) < received_) {
        x = rawAt(static_cast<uint64_t>(index));
        const float q = rfAt(static_cast<uint64_t>(index));
        if (std::isfinite(q)) {
          allUnknown = false;
          if (q < 0.30f) rfClose = false;
        } else {
          allKnown = false;
        }
      }
      frame[i] = x;
      const double w = hann()[i];
      energy += x * x * w * w;
      weight += w * w;
    }
    double low = 0.0, high = 0.0;
    for (int f = 400; f <= 3000; f += 100) low += bandPower(frame.data(), f);
    for (int f = 4000; f <= 7000; f += 100) high += bandPower(frame.data(), f);
    const float rms = std::sqrt(static_cast<float>(energy / std::max(weight, 1e-12)));
    const float ratio = static_cast<float>(10.0 * std::log10(((low / 27.0) + 1e-20) / ((high / 31.0) + 1e-20)));
    features_.push_back({nextFeature_, 20.0f * std::log10(std::max(rms, 1e-9f)), ratio,
                         allKnown, rfClose, allUnknown});
    if (nextFeature_ >= 199 && nextFeature_ % 100 == 0)
      templates_.push_back(makeTemplate(nextFeature_));
    ++nextFeature_;
    finalizeReady();
    prune();
  }
  finalizeReady();
}

PlaybackCore::NoiseTemplate PlaybackCore::makeTemplate(uint64_t index) const {
  std::vector<float> levels;
  for (const auto &f : features_)
    if (f.index <= index && index - f.index < kFeatureHistory) levels.push_back(f.level);
  if (levels.size() < 200) return {index, 0.0f, 0.0f, false};
  const float q25 = quantile(levels, 0.25f), q75 = quantile(levels, 0.75f);
  std::vector<float> ratios;
  for (const auto &f : features_)
    if (f.index <= index && index - f.index < kFeatureHistory && f.level >= q75)
      ratios.push_back(f.ratio);
  if (ratios.size() < 50) return {index, 0.0f, q75, false};
  const float center = median(ratios);
  std::vector<float> deviations;
  for (float value : ratios) deviations.push_back(std::abs(value - center));
  return {index, center, q75, q75 - q25 >= 8.0f && median(deviations) <= 2.0f};
}

const PlaybackCore::Feature *PlaybackCore::feature(int64_t index) const {
  if (index < 0) return nullptr;
  for (const auto &f : features_)
    if (f.index == static_cast<uint64_t>(index)) return &f;
  return nullptr;
}

const PlaybackCore::NoiseTemplate *PlaybackCore::templateFor(uint64_t index) const {
  for (auto it = templates_.rbegin(); it != templates_.rend(); ++it)
    if (it->index <= index) return &*it;
  return nullptr;
}

float PlaybackCore::smoothedRatio(uint64_t index) const {
  std::vector<float> values;
  for (int delta = -5; delta <= 5; ++delta)
    if (const auto *f = feature(static_cast<int64_t>(index) + delta)) values.push_back(f->ratio);
  return median(std::move(values));
}

float PlaybackCore::smoothedLevel(uint64_t index) const {
  std::vector<float> values;
  for (int delta = -5; delta <= 5; ++delta)
    if (const auto *f = feature(static_cast<int64_t>(index) + delta)) values.push_back(f->level);
  return median(std::move(values));
}

bool PlaybackCore::candidate(uint64_t index) const {
  const auto *f = feature(static_cast<int64_t>(index));
  if (!f) return false;
  if (f->allKnown) return f->rfClose;
  if (!f->allUnknown) return false;
  const auto *t = templateFor(index);
  if (!t || !t->valid || index < 17 || !feature(static_cast<int64_t>(index + 17))) return false;
  std::vector<float> ratios;
  for (int delta = -12; delta <= 12; ++delta)
    ratios.push_back(smoothedRatio(static_cast<uint64_t>(static_cast<int64_t>(index) + delta)));
  const float center = median(ratios);
  std::vector<float> deviations;
  for (float value : ratios) deviations.push_back(std::abs(value - center));
  return f->level >= t->q75 - 3.0f && smoothedLevel(index) >= t->q75 - 3.0f &&
         std::abs(smoothedRatio(index) - t->ratio) <= 2.5f &&
         median(std::move(deviations)) <= 1.5f;
}

void PlaybackCore::finalizeReady() {
  while (finalized_ * kHop < received_) {
    // 12 frames local MAD + 5 frames ratio smoothing; the same bound protects
    // the next feature referenced by candidate().
    if (!feature(static_cast<int64_t>(finalized_ + 17))) break;
    const bool isCandidate = candidate(finalized_);
    // Only classify this frame as noise after 24 earlier consecutive frames
    // have already established the past 250 ms. Earlier candidate frames stay
    // open, so this decision never mutates a gate envelope in the past.
    const bool confirmedNoise = isCandidate && candidateRun_ >= 24;
    classifyFrame(finalized_, !confirmedNoise);
    candidateRun_ = isCandidate ? std::min<uint64_t>(candidateRun_ + 1, 25) : 0;
    ++finalized_;
  }
}

void PlaybackCore::classifyFrame(uint64_t frame, bool open) {
  if (open) scheduleOpen(frame);
}

void PlaybackCore::scheduleOpen(uint64_t frame) {
  const uint64_t start = frame * kHop;
  const uint64_t end = start + kHop;
  const uint64_t fullStart = start > kPreroll ? start - kPreroll : 0;
  const uint64_t attackStart = fullStart > kAttack ? fullStart - kAttack : 0;
  for (uint64_t i = attackStart; i < fullStart; ++i) {
    const float t = static_cast<float>(i - attackStart + 1) /
                    static_cast<float>(std::max<uint64_t>(1, fullStart - attackStart));
    setGain(i, kFloor + (1.0f - kFloor) * (0.5f - 0.5f * std::cos(M_PI * t)));
  }
  const uint64_t holdEnd = end + kHold;
  for (uint64_t i = fullStart; i < holdEnd; ++i) setGain(i, 1.0f);
  const uint64_t releaseEnd = holdEnd + kRelease;
  for (uint64_t i = holdEnd; i < releaseEnd; ++i) {
    const float t = static_cast<float>(i - holdEnd + 1) / kRelease;
    setGain(i, kFloor + (1.0f - kFloor) * (0.5f + 0.5f * std::cos(M_PI * t)));
  }
}

void PlaybackCore::setGain(uint64_t index, float value) {
  if (index < written_) return;
  const uint64_t offset = index - gainBase_;
  if (offset >= kMaxGainRing) throw std::runtime_error("gate envelope ring exceeded its bound");
  while (gain_.size() <= offset) gain_.push_back(kFloor);
  gain_[static_cast<size_t>(offset)] = std::max(gain_[static_cast<size_t>(offset)], value);
  trackQueues();
}

void PlaybackCore::pump(bool eof) {
  const uint64_t safe = eof ? received_ :
      (received_ > kGateLookahead ? received_ - kGateLookahead : 0);
  const uint64_t count = std::min({safe > written_ ? safe - written_ : 0,
                                   generated_ > written_ ? generated_ - written_ : 0});
  for (uint64_t i = 0; i < count; ++i) {
    const float sample = denoised_.front() * gain_.front() * kFixedGain;
    denoised_.pop_front();
    gain_.pop_front();
    raw_.pop_front();
    rf_.pop_front();
    ++rawBase_;
    ++gainBase_;
    limited_.push_back(sample);
    trackQueues();
    ++written_;
    emitLimited(false);
  }
  if (eof) emitLimited(true);
}

void PlaybackCore::emitLimited(bool eof) {
  while (!limited_.empty() && (eof || limited_.size() > kLimiterLookahead)) {
    float peak = 0.0f;
    const size_t n = std::min<size_t>(limited_.size(), kLimiterLookahead + 1);
    for (size_t i = 0; i < n; ++i) peak = std::max(peak, std::abs(limited_[i]));
    const float target = peak > kPeakLimit ? kPeakLimit / peak : 1.0f;
    if (target < limiterGain_) limiterGain_ = target;
    else limiterGain_ += (target - limiterGain_) * (1.0f - std::exp(-1.0f / (kRate * 0.100f)));
    const float value = std::clamp(limited_.front() * limiterGain_, -kPeakLimit, kPeakLimit);
    const int16_t pcm = static_cast<int16_t>(std::lrint(value * 32767.0f));
    sink_(&pcm, 1);
    limited_.pop_front();
  }
}

void PlaybackCore::prune() {
  while (features_.size() > kFeatureHistory + 40) features_.pop_front();
  while (templates_.size() > 820) templates_.pop_front();
  if (raw_.size() > kMaxRawRing || rf_.size() > kMaxRawRing)
    throw std::runtime_error("source sample ring exceeded its bound");
}

void PlaybackCore::trackQueues() {
  maxQueuedSamples_ = std::max({maxQueuedSamples_, raw_.size(), rf_.size(), gain_.size(),
                                denoised_.size(), limited_.size()});
}

void PlaybackCore::finish() {
  appendDenoised(denoiser_.flush());
  if (generated_ != received_)
    throw std::runtime_error("denoiser did not generate one output sample per source sample");

  // No centered analysis window exists for the final 160 samples. Any frame
  // which remained undecided at EOF is treated as OPEN, including short tails.
  makeFeatures();
  while (finalized_ * kHop < received_) {
    classifyFrame(finalized_, true);
    ++finalized_;
  }
  pump(true);
  trackQueues();
  if (written_ != received_ || !denoised_.empty() || !limited_.empty())
    throw std::runtime_error("playback output sample count mismatch");
}

}  // namespace vhf
