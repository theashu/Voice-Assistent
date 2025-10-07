class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSampleRate = 44100;
    this.outputSampleRate = 24000;
    this.resampleRatio = this.inputSampleRate / this.outputSampleRate;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const monoChannel = input[0];
      const resampled = this.resample(monoChannel, this.resampleRatio);
      const pcm16 = this.float32To16BitPCM(resampled);
      this.port.postMessage(pcm16.buffer);
    }
    return true;
  }

  resample(buffer, ratio) {
    const inLength = buffer.length;
    const outLength = Math.round(inLength / ratio);
    const result = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const inIndex = i * ratio;
      const floor = Math.floor(inIndex);
      const ceil = Math.ceil(inIndex);
      const frac = inIndex - floor;
      result[i] = buffer[floor] * (1 - frac) + buffer[ceil] * frac;
    }
    return result;
  }

  float32To16BitPCM(input) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return output;
  }
}

registerProcessor("audio-processor", AudioProcessor);
