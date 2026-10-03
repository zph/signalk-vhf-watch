#include "playback-core.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {
class IdentityDenoiser final : public vhf::Denoiser {
 public:
  size_t recommendedBlock() const override { return 160; }
  std::vector<float> run(const float *samples, size_t n) override {
    ++calls;
    submitted += n;
    return {samples, samples + n};
  }
  std::vector<float> flush() override { ++flushes; return {}; }
  size_t calls = 0, flushes = 0;
  uint64_t submitted = 0;
};

class Delayed256Denoiser final : public vhf::Denoiser {
 public:
  size_t recommendedBlock() const override { return 256; }
  std::vector<float> run(const float *samples, size_t n) override {
    ++calls;
    submitted += n;
    pending.insert(pending.end(), samples, samples + n);
    if (pending.size() <= 256) return {};
    const size_t count = pending.size() - 256;
    std::vector<float> result(pending.begin(), pending.begin() + count);
    pending.erase(pending.begin(), pending.begin() + count);
    return result;
  }
  std::vector<float> flush() override {
    ++flushes;
    std::vector<float> result = pending;
    pending.clear();
    return result;
  }
  std::vector<float> pending;
  size_t calls = 0, flushes = 0;
  uint64_t submitted = 0;
};

class FaultDenoiser final : public vhf::Denoiser {
 public:
  enum class Fault { Short, Long };
  explicit FaultDenoiser(Fault fault) : fault_(fault) {}
  size_t recommendedBlock() const override { return 256; }
  std::vector<float> run(const float *samples, size_t n) override {
    pending.insert(pending.end(), samples, samples + n);
    if (pending.size() <= 256) return {};
    const size_t count = pending.size() - 256;
    std::vector<float> result(pending.begin(), pending.begin() + count);
    pending.erase(pending.begin(), pending.begin() + count);
    return result;
  }
  std::vector<float> flush() override {
    if (fault_ == Fault::Short) pending.pop_back();
    else pending.push_back(0.0f);
    return pending;
  }
 private:
  Fault fault_;
  std::vector<float> pending;
};

void require(bool value, const char *message) {
  if (!value) throw std::runtime_error(message);
}

std::vector<int16_t> makeSignal(size_t n) {
  std::vector<int16_t> result(n);
  for (size_t i = 0; i < n; ++i) {
    const float value = 0.18f * std::sin(2.0 * M_PI * 760.0 * i / 16000.0) +
                        0.07f * std::sin(2.0 * M_PI * 1450.0 * i / 16000.0);
    result[i] = static_cast<int16_t>(std::lrint(value * 32767.0f));
  }
  return result;
}

std::vector<int16_t> process(const std::vector<int16_t> &input,
                             const std::vector<size_t> &partitions,
                             const std::vector<float> &noiseBySample,
                             uint64_t *calls = nullptr,
                             float quieting = 100.0f) {
  IdentityDenoiser denoiser;
  std::vector<int16_t> output;
  vhf::PlaybackCore core(denoiser, [&output](const int16_t *samples, size_t n) {
    output.insert(output.end(), samples, samples + n);
  }, quieting);
  size_t at = 0, part = 0;
  while (at < input.size()) {
    const size_t requested = partitions[part++ % partitions.size()];
    const size_t count = std::min({requested, input.size() - at, size_t(1024)});
    float noise = noiseBySample.empty() ? std::numeric_limits<float>::quiet_NaN()
                                        : noiseBySample[at];
    size_t remain = count;
    while (remain) {
      size_t same = noiseBySample.empty() ? remain : 1;
      while (same < remain && !noiseBySample.empty() &&
             at + same < noiseBySample.size() && noiseBySample[at + same] == noise) ++same;
      core.accept(input.data() + at, same, noise);
      at += same;
      remain -= same;
      if (remain) noise = noiseBySample.empty() ? std::numeric_limits<float>::quiet_NaN()
                                                 : noiseBySample[at];
    }
  }
  core.finish();
  require(core.outputSamples() == input.size(), "exact output count mismatch");
  if (calls) *calls = denoiser.submitted;
  require(denoiser.flushes == 1, "denoiser must flush exactly once");
  return output;
}

std::vector<int16_t> processDelayed(const std::vector<int16_t> &input,
                                    const std::vector<size_t> &partitions) {
  Delayed256Denoiser denoiser;
  std::vector<int16_t> output;
  vhf::PlaybackCore core(denoiser, [&output](const int16_t *samples, size_t n) {
    output.insert(output.end(), samples, samples + n);
  });
  size_t at = 0, part = 0;
  while (at < input.size()) {
    const size_t count = std::min({partitions[part++ % partitions.size()], input.size() - at,
                                   size_t(1024)});
    core.accept(input.data() + at, count, std::numeric_limits<float>::quiet_NaN());
    at += count;
  }
  core.finish();
  require(core.outputSamples() == input.size(), "delayed denoiser EOF count mismatch");
  require(denoiser.submitted == input.size(), "delayed denoiser input count mismatch");
  require(denoiser.flushes == 1, "delayed denoiser must flush exactly once");
  return output;
}

void testDenoiserCountFaults() {
  const auto input = makeSignal(1024);
  for (const auto fault : {FaultDenoiser::Fault::Short, FaultDenoiser::Fault::Long}) {
    FaultDenoiser denoiser(fault);
    vhf::PlaybackCore core(denoiser, [](const int16_t *, size_t) {});
    core.accept(input.data(), input.size(), std::numeric_limits<float>::quiet_NaN());
    bool threw = false;
    try {
      core.finish();
    } catch (const std::runtime_error &) {
      threw = true;
    }
    require(threw, fault == FaultDenoiser::Fault::Short
                       ? "short denoiser output must fail at EOF"
                       : "long denoiser output must fail instead of being trimmed");
  }
}

void testBelowCapConstantGain() {
  std::vector<int16_t> input(16000);
  for (size_t i = 0; i < input.size(); ++i)
    input[i] = static_cast<int16_t>(std::lrint(280.0 * std::sin(2.0 * M_PI * 910.0 * i / 16000.0)));
  const auto output = process(input, {1024, 129, 511}, {});
  for (size_t i = 0; i < output.size(); ++i) {
    const auto expected = static_cast<int16_t>(std::lrint(
        (static_cast<float>(input[i]) / 32768.0f) * 3.758374f * 32767.0f));
    require(output[i] == expected, "below-cap samples must be only fixed gain");
  }
}

void testPartitionsAndEof() {
  for (size_t n : {size_t(1), size_t(159), size_t(160), size_t(161), size_t(319),
                   size_t(320), size_t(321), size_t(639), size_t(640), size_t(641),
                   size_t(16000 + 77)}) {
    const auto input = makeSignal(n);
    uint64_t submitted = 0;
    const auto whole = process(input, {1024}, {}, &submitted);
    const auto split = process(input, {1, 13, 157, 2, 319, 17, 511}, {}, nullptr);
    require(submitted == n, "some source samples were not submitted exactly once");
    require(whole == split, "output depends on input partitioning");
    std::vector<float> knownNoise(n, 0.65f);
    const auto wholeKnown = process(input, {1024}, knownNoise);
    const auto splitKnown = process(input, {1, 13, 157, 2, 319, 17, 511}, knownNoise);
    require(wholeKnown == splitKnown, "known-RF output depends on input partitioning");
    for (size_t i = 0; i < n; ++i) knownNoise[i] = ((i / 777) % 2) ? 0.0f : 0.65f;
    const auto wholeChanging = process(input, {1024}, knownNoise);
    const auto splitChanging = process(input, {1, 13, 157, 2, 319, 17, 511}, knownNoise);
    require(wholeChanging == splitChanging, "alternating RF output depends on input partitioning");
  }
  for (size_t n : {size_t(257), size_t(640), size_t(16000 + 77)}) {
    const auto input = makeSignal(n);
    const auto whole = processDelayed(input, {1024});
    const auto split = processDelayed(input, {1, 13, 157, 2, 319, 17, 511});
    require(whole == split, "delayed 256-sample denoiser depends on input partitioning");
  }
}

void testGateAndLimiter() {
  constexpr size_t n = 16000 * 5;
  auto input = makeSignal(n);
  std::vector<float> rf(n, 0.7f);
  std::fill(rf.begin() + 2 * 16000, rf.end(), 0.0f);
  const auto output = process(input, {1024, 79, 512, 1, 911}, rf);
  const auto outputSplit = process(input, {1, 13, 157, 2, 319, 17, 511}, rf);
  require(output == outputSplit, "RF gate alignment depends on input partitioning");
  const auto unknownWhole = process(input, {1024}, {});
  const auto unknownSplit = process(input, {1, 13, 157, 2, 319, 17, 511}, {});
  require(unknownWhole == unknownSplit, "unknown-RF gate depends on input partitioning");
  double hiss = 0.0, speech = 0.0;
  for (size_t i = 16000; i < 19000; ++i) hiss += std::abs(output[i]);
  for (size_t i = 2 * 16000; i < 2 * 16000 + 2400; ++i) speech += std::abs(output[i]);
  require(speech > hiss * 1.2, "quiet/open transition did not preserve onset and preroll");
  for (int16_t sample : output)
    require(std::abs(static_cast<int>(sample)) <= 29204, "peak protection exceeded -1 dBFS");

  auto impulse = std::vector<int16_t>(16000, 0);
  impulse[1023] = 30000;
  impulse[1024] = 30000;
  const auto limited = process(impulse, {1023, 1, 511, 17}, {});
  require(*std::max_element(limited.begin(), limited.end()) <= 29204,
          "limiter failed across a chunk seam");
}

void testQuietingIntensity() {
  constexpr size_t n = 16000 * 5;
  const auto input = makeSignal(n);
  std::vector<float> rf(n, 0.7f);
  std::fill(rf.begin() + 2 * 16000, rf.end(), 0.0f);
  const auto full = process(input, {1024, 79, 512}, rf, nullptr, 100.0f);
  const auto gentle = process(input, {1024, 79, 512}, rf, nullptr, 50.0f);
  const auto off = process(input, {1024, 79, 512}, rf, nullptr, 0.0f);
  auto energy = [](const std::vector<int16_t> &samples, size_t start, size_t count) {
    uint64_t sum = 0;
    for (size_t i = start; i < start + count; ++i) sum += static_cast<uint64_t>(std::abs(static_cast<int>(samples[i])));
    return sum;
  };
  const auto closedFull = energy(full, 16000, 3000);
  const auto closedGentle = energy(gentle, 16000, 3000);
  const auto closedOff = energy(off, 16000, 3000);
  require(closedFull < closedGentle && closedGentle < closedOff,
          "quieting intensity must monotonically attenuate the closed gate");
  require(energy(full, 2 * 16000, 2400) == energy(gentle, 2 * 16000, 2400) &&
              energy(gentle, 2 * 16000, 2400) == energy(off, 2 * 16000, 2400),
          "quieting intensity must leave the open gate region unchanged");
}

void testQuietingValidation() {
  for (const char *value : {"", "nan", "inf", "-1", "101", "50x"}) {
    bool threw = false;
    try { (void)vhf::parseQuietingIntensity(value); }
    catch (const std::invalid_argument &) { threw = true; }
    require(threw, "invalid quieting CLI value was accepted");
  }
  require(vhf::parseQuietingIntensity("0") == 0.0f && vhf::parseQuietingIntensity("50") == 50.0f &&
              vhf::parseQuietingIntensity("100") == 100.0f,
          "valid quieting CLI values were not parsed");
}

void testBoundedLongStream() {
  IdentityDenoiser denoiser;
  std::vector<int16_t> output;
  vhf::PlaybackCore core(denoiser, [&output](const int16_t *samples, size_t n) {
    output.insert(output.end(), samples, samples + n);
  });
  const auto block = makeSignal(1024);
  constexpr int seconds = 70;
  constexpr int blocksPerSecond = 16000 / 1024 + 1;
  const int blocks = seconds * blocksPerSecond;
  for (int i = 0; i < blocks; ++i) {
    core.accept(block.data(), block.size(), std::numeric_limits<float>::quiet_NaN());
    // Public exact counters also prove the processing loop advances through a
    // long live stream without accumulating input-sized queues.
    require(core.maxQueuedSamples() <= 20000, "streaming queues exceeded the sample bound");
  }
  core.finish();
  require(core.maxQueuedSamples() <= 20000, "long stream queues exceeded the sample bound");
  const uint64_t expected = static_cast<uint64_t>(blocks) * block.size();
  require(core.outputSamples() == expected, "long stream output count mismatch");
  require(output.size() == expected, "long stream sink count mismatch");
}
}  // namespace

int main() {
  try {
    testPartitionsAndEof();
    testBelowCapConstantGain();
    testGateAndLimiter();
    testQuietingIntensity();
    testQuietingValidation();
    testDenoiserCountFaults();
    testBoundedLongStream();
    std::cout << "native playback core tests passed\n";
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
