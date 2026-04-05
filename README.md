# GemmaSight

Real-time AI Screen Analysis & Description powered by Gemma 4 and Transformers.js.

GemmaSight is a desktop application that allows you to capture any portion of your screen and get instant, intelligent descriptions using the latest Gemma 4 vision-language models running entirely locally on your device via WebGPU.

## Features

- **Real-time Screen Capture**: Select any window or screen area for analysis.
- **Local AI Inference**: Powered by Transformers.js and ONNX Runtime, ensuring your data never leaves your machine.
- **Gemma 4 Integration**: Leverages the state-of-the-art Gemma 4 models for high-quality visual understanding.
- **Customizable Prompts**: Ask specific questions about your screen or get general descriptions.
- **Cross-Platform**: Built with Electron, Vue 3, and TypeScript.
- **Detailed Documentation**: ✨ [GemmaSight ドキュメント (GitHub Pages)](https://blue1st.github.io/gemma-sight/)

## Getting Started

### Prerequisites

- Node.js (v18 or later)
- A browser/environment supporting WebGPU (for optimal performance)

### Installation

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For macOS
$ npm run build:mac

# For Windows
$ npm run build:win

# For Linux
$ npm run build:linux
```

## Tech Stack

- **Framework**: [Electron](https://www.electronjs.org/)
- **Frontend**: [Vue 3](https://vuejs.org/) + [Vite](https://vitejs.dev/)
- **AI Engine**: [Transformers.js](https://huggingface.co/docs/transformers.js/index)
- **Model**: Gemma 4 (ONNX)

---

Developed as a sandbox for exploring the capabilities of local LLMs and computer vision.
