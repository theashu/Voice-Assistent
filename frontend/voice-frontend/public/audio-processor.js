class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSampleRate = 48000; // Most modern browsers use 48kHz
    this.outputSampleRate = 24000; // OpenAI expects 24kHz
    this.resampleRatio = this.inputSampleRate / this.outputSampleRate;
    this.bufferSize = 1024; // Process in chunks
    this.inputBuffer = [];
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
        const bufferArray = new Float32Array(this.inputBuffer.slice(0, this.bufferSize));
        this.inputBuffer = this.inputBuffer.slice(this.bufferSize);
        
        const resampled = this.resample(bufferArray, this.resampleRatio);
        const pcm16 = this.float32To16BitPCM(resampled);
        
        // Only send if we have meaningful audio (not silence)
        if (this.hasAudioContent(resampled)) {
          this.port.postMessage(pcm16.buffer);
        }
      }
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

  hasAudioContent(buffer) {
    // Check if buffer contains meaningful audio (not just silence)
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += Math.abs(buffer[i]);
    }
    const average = sum / buffer.length;
    return average > 0.001; // Threshold for meaningful audio
  }
}

registerProcessor("audio-processor", AudioProcessor);
