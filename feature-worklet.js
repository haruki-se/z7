import {FeatureExtractor} from './analysis.js';
class GuitarFeatures extends AudioWorkletProcessor {
  constructor() {
    super(); this.extractor = new FeatureExtractor(sampleRate);
    this.frame = new Float32Array(2048); this.filled = 0;
    this.settings = {channel: 'left', gateDb: -55, attackDb: 6};
    this.port.onmessage = ({data}) => { this.settings = {...this.settings, ...data}; };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const left = channels[0], right = channels[1] || left;
    for (let i = 0; i < left.length; i++) {
      this.frame[this.filled++] = this.settings.channel === 'right' ? right[i] : this.settings.channel === 'mix' ? (left[i] + right[i]) / 2 : left[i];
      if (this.filled === 2048) {
        this.port.postMessage(this.extractor.analyze(this.frame, currentTime + (i + 1) / sampleRate, this.settings.gateDb, this.settings.attackDb));
        this.frame.copyWithin(0, 1024); this.filled = 1024;
      }
    }
    // Output stays silent. The separate monitoring path preserves stereo audio.
    return true;
  }
}
registerProcessor('guitar-features', GuitarFeatures);
