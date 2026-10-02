// Native streaming playback filter. stdin is length+RF+PCM framed; stdout is
// PCM16LE only. All DSP runs here, outside the Signal K event loop.
#include "playback-core.h"
#include "sherpa-online-denoiser.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <sys/resource.h>
#include <unistd.h>
#include <vector>

namespace {
constexpr uint32_t kRate = 16000;
constexpr uint32_t kMaxRecordBytes = 20u * 1024u * 1024u;
constexpr size_t kBlockSamples = 1024;

bool readExact(FILE *file, void *buffer, size_t size, bool allowCleanEof = false) {
  auto *bytes = static_cast<unsigned char *>(buffer);
  size_t done = 0;
  while (done < size) {
    const size_t n = std::fread(bytes + done, 1, size - done, file);
    if (n == 0) {
      if (allowCleanEof && done == 0 && std::feof(file)) return false;
      throw std::runtime_error("truncated playback input record");
    }
    done += n;
  }
  return true;
}

uint32_t loadLe32(const unsigned char bytes[4]) {
  return static_cast<uint32_t>(bytes[0]) |
         (static_cast<uint32_t>(bytes[1]) << 8) |
         (static_cast<uint32_t>(bytes[2]) << 16) |
         (static_cast<uint32_t>(bytes[3]) << 24);
}

float loadLeFloat(const unsigned char bytes[4]) {
  const uint32_t bits = loadLe32(bytes);
  float value;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

int16_t loadLePcm(const unsigned char bytes[2]) {
  const uint16_t bits = static_cast<uint16_t>(bytes[0]) |
                        (static_cast<uint16_t>(bytes[1]) << 8);
  int16_t value;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

class SherpaDenoiser final : public vhf::Denoiser {
 public:
  explicit SherpaDenoiser(const char *path) {
    SherpaOnnxOnlineSpeechDenoiserConfig config{};
    config.model.gtcrn.model = path;
    config.model.num_threads = 1;
    config.model.debug = 0;
    config.model.provider = "cpu";
    handle_ = SherpaOnnxCreateOnlineSpeechDenoiser(&config);
    if (!handle_) throw std::runtime_error("could not initialize the GTCRN model");
    if (SherpaOnnxOnlineSpeechDenoiserGetSampleRate(handle_) != static_cast<int32_t>(kRate)) {
      SherpaOnnxDestroyOnlineSpeechDenoiser(handle_);
      handle_ = nullptr;
      throw std::runtime_error("GTCRN model requires an unsupported sample rate");
    }
    frameHop_ = SherpaOnnxOnlineSpeechDenoiserGetFrameShiftInSamples(handle_);
    if (frameHop_ <= 0) {
      SherpaOnnxDestroyOnlineSpeechDenoiser(handle_);
      handle_ = nullptr;
      throw std::runtime_error("GTCRN returned an invalid frame hop");
    }
  }

  ~SherpaDenoiser() override {
    if (handle_) SherpaOnnxDestroyOnlineSpeechDenoiser(handle_);
  }

  std::vector<float> run(const float *samples, size_t n) override {
    if (n == 0 || n > kBlockSamples) throw std::runtime_error("invalid denoiser subblock");
    return take(SherpaOnnxOnlineSpeechDenoiserRun(
        handle_, samples, static_cast<int32_t>(n), static_cast<int32_t>(kRate)));
  }

  size_t recommendedBlock() const override {
    return static_cast<size_t>(frameHop_);
  }

  std::vector<float> flush() override {
    return take(SherpaOnnxOnlineSpeechDenoiserFlush(handle_));
  }

  int32_t frameHop() const { return frameHop_; }

 private:
  static std::vector<float> take(const SherpaOnnxDenoisedAudio *audio) {
    if (!audio) return {};
    if (audio->sample_rate != static_cast<int32_t>(kRate) || audio->n < 0) {
      SherpaOnnxDestroyDenoisedAudio(audio);
      throw std::runtime_error("GTCRN returned an invalid audio block");
    }
    std::vector<float> result(audio->samples, audio->samples + audio->n);
    SherpaOnnxDestroyDenoisedAudio(audio);
    return result;
  }

  const SherpaOnnxOnlineSpeechDenoiser *handle_ = nullptr;
  int32_t frameHop_ = 0;
};

bool writePcm(const int16_t *samples, size_t n) {
  std::array<unsigned char, kBlockSamples * 2> bytes{};
  if (n > kBlockSamples) throw std::runtime_error("internal output block exceeded its bound");
  for (size_t i = 0; i < n; ++i) {
    uint16_t bits;
    std::memcpy(&bits, &samples[i], sizeof(bits));
    bytes[2 * i] = static_cast<unsigned char>(bits & 0xffu);
    bytes[2 * i + 1] = static_cast<unsigned char>((bits >> 8) & 0xffu);
  }
  return std::fwrite(bytes.data(), 2, n, stdout) == n;
}

int run(int argc, char **argv) {
  const char *modelPath = nullptr;
  uint32_t sampleRate = 0;
  for (int i = 1; i < argc; ++i) {
    const std::string arg(argv[i]);
    if (arg == "--model" && i + 1 < argc) modelPath = argv[++i];
    else if (arg == "--sample-rate" && i + 1 < argc) {
      char *end = nullptr;
      errno = 0;
      const unsigned long value = std::strtoul(argv[++i], &end, 10);
      if (errno || !end || *end || value > std::numeric_limits<uint32_t>::max())
        throw std::runtime_error("invalid --sample-rate value");
      sampleRate = static_cast<uint32_t>(value);
    } else {
      throw std::runtime_error("usage: vhf-playback-denoiser --model PATH --sample-rate 16000");
    }
  }
  if (!modelPath || !*modelPath || sampleRate != kRate)
    throw std::runtime_error("usage: vhf-playback-denoiser --model PATH --sample-rate 16000");

  setpriority(PRIO_PROCESS, 0, 10);
  SherpaDenoiser denoiser(modelPath);
  // The C API hop is queried and validated at readiness. Run accepts arbitrary
  // bounded blocks and owns its buffering; no partial tail is discarded here.
  if (denoiser.frameHop() > static_cast<int32_t>(kBlockSamples))
    throw std::runtime_error("GTCRN frame hop exceeds the bounded input block");
  const unsigned char ready = 'R';
  if (::write(3, &ready, 1) != 1) throw std::runtime_error("could not signal model readiness");

  vhf::PlaybackCore core(denoiser, [](const int16_t *samples, size_t n) {
    if (!writePcm(samples, n)) throw std::runtime_error("could not write playback PCM");
  });

  while (true) {
    unsigned char lengthBytes[4];
    if (!readExact(stdin, lengthBytes, sizeof(lengthBytes), true)) break;
    const uint32_t byteLength = loadLe32(lengthBytes);
    unsigned char noiseBytes[4];
    if (!readExact(stdin, noiseBytes, sizeof(noiseBytes)) || byteLength == 0 ||
        byteLength > kMaxRecordBytes || (byteLength & 1u))
      throw std::runtime_error("invalid playback input record");
    const float noise = loadLeFloat(noiseBytes);
    uint32_t remaining = byteLength / 2;
    std::array<unsigned char, kBlockSamples * 2> pcmBytes{};
    std::array<int16_t, kBlockSamples> pcm{};
    while (remaining > 0) {
      const size_t count = std::min<size_t>(remaining, kBlockSamples);
      readExact(stdin, pcmBytes.data(), count * 2);
      for (size_t i = 0; i < count; ++i) pcm[i] = loadLePcm(&pcmBytes[i * 2]);
      core.accept(pcm.data(), count, noise);
      remaining -= static_cast<uint32_t>(count);
    }
  }
  core.finish();
  std::fflush(stdout);
  return 0;
}
}  // namespace

int main(int argc, char **argv) {
  try {
    return run(argc, argv);
  } catch (const std::exception &error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 2;
  }
}
