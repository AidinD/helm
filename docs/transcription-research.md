# Voice transcription: research + speed plan (2026-07-04)

Research into why Maestro's Swedish voice transcription is slow, and how to fix it.
Full sourced report is in the session transcript; this captures the durable conclusions and the plan.

## The core finding

We are already on the best small-footprint Swedish model that exists.
KB-Whisper-small (244M, KBLab/National Library of Sweden) beats OpenAI's full large-v3 (1.5B) on Swedish WER (7.3 vs 7.8 on FLEURS).
So the model is NOT the problem, and swapping models is not the lever.

The latency comes from two things we have not yet touched:

1. The runtime.
Maestro runs the model through transformers.js -> onnxruntime-node's CPU execution provider, which the ONNX Runtime team itself benchmarks at 2-4x slower than optimized native inference.
We only ever pulled the quantization lever (fp32 -> q8 -> q4), which lowers cost-per-matmul but not the number of matmuls, so it hit a floor.

2. The decoding strategy.
Whisper decodes autoregressively (one token at a time), so decoder time dominates wall-clock for anything but the shortest clips.
voice.js does not set `num_beams`, so the pipeline default (likely beam search, width 5) is in effect - a ~5x decoder-cost tax for marginal quality gain on short dictation clips.
No VAD, so leading/trailing silence still gets a full encoder+decoder pass.

## Hardware (confirmed 2026-07-04)

This machine has an NVIDIA GeForce RTX 3070 (8GB), driver present, nvidia-smi works.
That unlocks the GPU path (Path A), which is the fastest realistic option and needs no Python.

## Key enabler

KBLab publishes KB-Whisper in multiple formats: ONNX (current), CTranslate2 (faster-whisper), and GGML (whisper.cpp).
So switching runtime is a drop-in model-file swap - no re-training, no re-conversion, no loss of the Swedish specialization.

## The plan (staged, cheapest-first)

### Step 0 - free, near-zero-risk, do first
In the current transformers.js pipeline call, set greedy decoding (`num_beams: 1`) and `condition_on_previous_text: false`, and measure the before/after latency on a real Swedish clip.
This costs minutes and isolates how much of the slowness is decoding-strategy vs runtime.
It may not be enough alone (the runtime is the bigger issue) but it is free and informative.

### Step 1 - the real fix (given the RTX 3070): whisper.cpp + CUDA
Spike whisper.cpp as a subprocess: prebuilt Windows CUDA binary + KBLab's official GGML kb-whisper-small checkpoint (`ggml-model.bin` ~488MB, or pre-quantized `ggml-model-q5_0.bin` ~175MB).
Drive it from the existing Electron utility process (whisper-server HTTP API, or the CLI), replacing the transformers.js/onnxruntime path.
Expected 5-15x over the current CPU path.
This mirrors the original OpenSuperWhisper-inspired subprocess decision already noted in voice.js; the earlier rejection of nodejs-whisper was about compile-from-source, which prebuilt binaries sidestep.

### Step 2 - accuracy spot-check (do not skip)
GGML's q5_0 quantization differs from ONNX q4, so verify Swedish accuracy on the whisper.cpp path is not silently worse than today before committing.
A like-for-like Swedish clip comparison, not just a speed check.

### Step 3 - refinements
Add Silero VAD (~1.8MB, built into most whisper.cpp/faster-whisper builds) to trim silence.
Only build streaming/partial transcription if Steps 0-2 do not get latency low enough - it is a large lift for a UX benefit push-to-talk may not need.

### Fallbacks (in order, only if needed)
- CPU-only path (if the GPU is ever unavailable on a target machine): whisper.cpp CPU (SIMD) or faster-whisper (CTranslate2 int8) - both have KBLab checkpoints.
- Size lever: drop to kb-whisper-base (still Swedish-specialized, already earmarked in voice.js) before any non-KBLab model.
- Not recommended: generic whisper-large-v3-turbo (its multilingual/Swedish degradation is larger than its English, and KB-Whisper-small already beats generic large-v3 on Swedish). No Swedish-specialized turbo exists.

## What to verify with a spike (priority order)
1. Step 0 greedy + no-condition delta (minutes).
2. whisper.cpp CUDA subprocess: end-to-end wall-clock on a real Swedish clip vs the transformers.js baseline.
3. Swedish accuracy spot-check on the GGML path.
