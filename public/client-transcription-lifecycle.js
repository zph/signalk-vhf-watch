// A tiny, injectable dwell gate so selection and visibility rules are easy to test.
(function (root) {
  class DwellGate {
    constructor(delayMs, timers = globalThis) {
      this.delayMs = delayMs
      this.timers = timers
      this.timer = undefined
      this.key = undefined
      this.onReady = undefined
    }

    reset(key, onReady) {
      this.cancel()
      this.key = key
      this.onReady = onReady
      this.timer = this.timers.setTimeout(() => {
        const callback = this.onReady
        this.timer = undefined
        this.onReady = undefined
        if (callback) callback(this.key)
      }, this.delayMs)
    }

    cancel() {
      if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
      this.timer = undefined
      this.onReady = undefined
      this.key = undefined
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { DwellGate }
  if (root) root.ClientTranscriptionLifecycle = { DwellGate }
})(typeof globalThis === 'undefined' ? this : globalThis)
