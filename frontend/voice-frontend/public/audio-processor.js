class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSampleRate = 48000; // Most modern browsers use 48kHz
    this.outputSampleRate = 24000; // OpenAI expects 24kHz
    this.resampleRatio = this.inputSampleRate / this.outputSampleRate;
    this.bufferSize = 256; // Smaller chunks for lower latency
    this.inputBuffer = [];
    this.port.onmessage = (event) => {
      if (event && event.data === "flush") {
        this.flushBuffer(true);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const monoChannel = input[0];
      
      // Accumulate samples in buffer for better processing
      for (let i = 0; i < monoChannel.length; i++) {
        this.inputBuffer.push(monoChannel[i]);
      }
      
      // Process when we have enough samples
      if (this.inputBuffer.length >= this.bufferSize) {
        this.flushBuffer();
      }
    }
    return true;
  }

  flushBuffer(force = false) {
    if (this.inputBuffer.length === 0) return;

    const sliceLength = force ? this.inputBuffer.length : this.bufferSize;
    const chunk = new Float32Array(this.inputBuffer.slice(0, sliceLength));
    this.inputBuffer = this.inputBuffer.slice(sliceLength);

    const resampled = this.resample(chunk, this.resampleRatio);
    const pcm16 = this.float32To16BitPCM(resampled);

    if (force || this.hasAudioContent(resampled)) {
      this.port.postMessage(pcm16.buffer);
    }

    // If more data remains after a forced flush, continue flushing until empty
    if (force && this.inputBuffer.length > 0) {
      this.flushBuffer(true);
    }
  }

  resample(buffer, ratio) {
    const inLength = buffer.length;
    const outLength = Math.round(inLength / ratio);
    const result = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const inIndex = i * ratio;
      const floor = Math.floor(inIndex);
      const ceil = Math.min(inLength - 1, Math.ceil(inIndex));
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

  hasAudioContent(buffer) {
    // Check if buffer contains meaningful audio (not just silence)
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += Math.abs(buffer[i]);
    }
    const average = sum / buffer.length;
    return average > 0.0005; // Lower threshold to reduce missed speech
  }
}

registerProcessor("audio-processor", AudioProcessor);
