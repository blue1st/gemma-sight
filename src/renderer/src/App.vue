<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue'

interface ScreenSource {
  id: string
  name: string
  display_id: string
}

const sourceType = ref<'screen' | 'webcam'>('screen')
const selectedSourceId = ref<string>('')
const screenSources = ref<ScreenSource[]>([])
const webcamSources = ref<MediaDeviceInfo[]>([])
const videoRef = ref<HTMLVideoElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

// Crop Box State
const cropBox = ref({ x: 50, y: 50, width: 200, height: 150 })
const isDragging = ref(false)
const isResizing = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const initialBox = ref({ x: 0, y: 0, width: 0, height: 0 })

const modelId = ref('onnx-community/gemma-4-E2B-it-ONNX')
const DEFAULT_PROMPT = 'Describe this image in Japanese.'
const promptText = ref(DEFAULT_PROMPT)

function resetPrompt(): void {
  promptText.value = DEFAULT_PROMPT
}

const resultText = ref('')
const isLoading = ref(false)
const modelStatus = ref('Ready to load')
const loadProgress = ref(0)
const isCopied = ref(false)
const isSaved = ref(false)
const isStreamingToFile = ref(false)
const streamingFilePath = ref('')
const isStreaming = ref(false)
const isModelLoaded = ref(false)
const resultRef = ref<HTMLPreElement | null>(null)

// Auto-scroll logic
watch(resultText, () => {
  nextTick(() => {
    if (resultRef.value) {
      resultRef.value.scrollTop = resultRef.value.scrollHeight
    }
  })
})

function clearResult(): void {
  resultText.value = ''
}

let worker: Worker | null = null

function toggleStreaming(): void {
  isStreaming.value = !isStreaming.value
  if (isStreaming.value) {
    captureAndAnalyze()
  }
}

async function copyToClipboard(): Promise<void> {
  if (!resultText.value) return
  try {
    await navigator.clipboard.writeText(resultText.value)
    isCopied.value = true
    setTimeout(() => {
      isCopied.value = false
    }, 2000)
  } catch (err) {
    console.error('Failed to copy:', err)
  }
}

async function saveToFile(): Promise<void> {
  if (!resultText.value) return
  try {
    const success = await window.electron.ipcRenderer.invoke(
      'save-analysis-result',
      resultText.value
    )
    if (success) {
      isSaved.value = true
      setTimeout(() => {
        isSaved.value = false
      }, 2000)
    }
  } catch (err) {
    console.error('Failed to save file:', err)
  }
}

async function selectStreamingFile(): Promise<void> {
  try {
    const path = await window.electron.ipcRenderer.invoke('select-output-file')
    if (path) {
      streamingFilePath.value = path
    }
  } catch (err) {
    console.error('Failed to select file:', err)
  }
}

function initWorker(): void {
  if (worker) return
  worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module'
  })

  worker.onmessage = (e): void => {
    const { type, payload, error } = e.data
    switch (type) {
      case 'progress':
        if (payload.status === 'progress') {
          loadProgress.value = payload.progress
        }
        modelStatus.value = `Loading: ${payload.file || ''} (${Math.round(payload.progress || 0)}%)`
        break
      case 'loaded':
        isLoading.value = false
        modelStatus.value = 'Model Loaded Successfully'
        loadProgress.value = 100
        isModelLoaded.value = true
        break
      case 'chunk':
        resultText.value += payload
        if (isStreamingToFile.value && streamingFilePath.value) {
          window.electron.ipcRenderer.invoke('append-to-file', {
            filePath: streamingFilePath.value,
            content: payload
          })
        }
        break
      case 'generated':
        isLoading.value = false
        if (!isStreaming.value) {
          resultText.value = payload
          if (isStreamingToFile.value && streamingFilePath.value) {
            window.electron.ipcRenderer.invoke('append-to-file', {
              filePath: streamingFilePath.value,
              content: payload + '\n'
            })
          }
        } else {
          // In streaming mode, chunks already populated resultText.
          // We just add a double newline to separate from next capture.
          resultText.value += '\n'
          if (isStreamingToFile.value && streamingFilePath.value) {
            window.electron.ipcRenderer.invoke('append-to-file', {
              filePath: streamingFilePath.value,
              content: '\n'
            })
          }
        }
        // Trigger next capture if streaming
        if (isStreaming.value) {
          setTimeout(() => {
            if (isStreaming.value) captureAndAnalyze()
          }, 500)
        }
        break
      case 'error':
        isLoading.value = false
        isStreaming.value = false
        modelStatus.value = `Error: ${error}`
        resultText.value = `Error: ${error}`
        break
    }
  }
}

async function fetchSources(): Promise<void> {
  // Fetch screen/window sources
  const sSources = await window.electron.ipcRenderer.invoke('get-desktop-sources', {
    types: ['screen', 'window']
  })
  screenSources.value = sSources

  // Fetch webcam sources
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    webcamSources.value = devices.filter((device) => device.kind === 'videoinput')
  } catch (err) {
    console.error('Failed to get webcam devices:', err)
  }

  // Set default source if none selected
  if (!selectedSourceId.value) {
    if (sourceType.value === 'screen' && screenSources.value.length > 0) {
      selectedSourceId.value = screenSources.value[0].id
      startStream()
    } else if (sourceType.value === 'webcam' && webcamSources.value.length > 0) {
      selectedSourceId.value = webcamSources.value[0].deviceId
      startStream()
    }
  }
}

onMounted(async () => {
  await fetchSources()
})

async function onSourceTypeChange(): Promise<void> {
  selectedSourceId.value = ''
  if (sourceType.value === 'screen' && screenSources.value.length > 0) {
    selectedSourceId.value = screenSources.value[0].id
  } else if (sourceType.value === 'webcam' && webcamSources.value.length > 0) {
    selectedSourceId.value = webcamSources.value[0].deviceId
  }
  startStream()
}

async function startStream(): Promise<void> {
  const sourceId = selectedSourceId.value
  try {
    let stream: MediaStream
    if (sourceType.value === 'screen') {
      if (!sourceId) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        } as any
      })
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: sourceId ? { deviceId: { exact: sourceId } } : true
      })
    }

    if (videoRef.value) {
      videoRef.value.srcObject = stream
      videoRef.value.play()
    }
  } catch (err) {
    console.error('Failed to get stream:', err)
  }
}

async function loadModel(): Promise<void> {
  if (isLoading.value) return
  initWorker()
  isLoading.value = true
  modelStatus.value = `Initializing model ${modelId.value}...`
  worker?.postMessage({
    type: 'load',
    payload: { modelId: modelId.value }
  })
}

async function captureAndAnalyze(): Promise<void> {
  if (!worker) {
    await loadModel()
  }

  if (!videoRef.value || !canvasRef.value) return

  const video = videoRef.value
  const canvas = canvasRef.value
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // The video element's displayed size vs intrinsic size
  const scaleX = video.videoWidth / video.clientWidth
  const scaleY = video.videoHeight / video.clientHeight

  const cropX = cropBox.value.x * scaleX
  const cropY = cropBox.value.y * scaleY
  const cropW = cropBox.value.width * scaleX
  const cropH = cropBox.value.height * scaleY

  canvas.width = cropW
  canvas.height = cropH

  // Draw the cropped portion
  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

  const dataUrl = canvas.toDataURL('image/jpeg')

  isLoading.value = true
  if (isStreaming.value) {
    const timestamp = new Date().toLocaleTimeString()
    const header = `\n[${timestamp}] `
    resultText.value += header
    if (isStreamingToFile.value && streamingFilePath.value) {
      window.electron.ipcRenderer.invoke('append-to-file', {
        filePath: streamingFilePath.value,
        content: header
      })
    }
  } else {
    resultText.value = ''
  }

  worker?.postMessage({
    type: 'generate',
    payload: {
      promptText: promptText.value,
      dataUrl
    }
  })
}

// --- Box Drag / Resize Logic ---
function onBoxMouseDown(event: MouseEvent): void {
  isDragging.value = true
  dragStart.value = { x: event.clientX, y: event.clientY }
  initialBox.value = { ...cropBox.value }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onHandleMouseDown(event: MouseEvent): void {
  event.stopPropagation()
  isResizing.value = true
  dragStart.value = { x: event.clientX, y: event.clientY }
  initialBox.value = { ...cropBox.value }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(event: MouseEvent): void {
  const dx = event.clientX - dragStart.value.x
  const dy = event.clientY - dragStart.value.y

  if (isDragging.value) {
    cropBox.value.x = initialBox.value.x + dx
    cropBox.value.y = initialBox.value.y + dy
  } else if (isResizing.value) {
    cropBox.value.width = Math.max(50, initialBox.value.width + dx)
    cropBox.value.height = Math.max(50, initialBox.value.height + dy)
  }
}

function onMouseUp(): void {
  isDragging.value = false
  isResizing.value = false
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  worker?.terminate()
})
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="controls-container">
        <div class="control-row">
          <div class="control-group">
            <label>Source Type</label>
            <select v-model="sourceType" @change="onSourceTypeChange">
              <option value="screen">Screen / Window</option>
              <option value="webcam">WebCam</option>
            </select>
          </div>

          <div class="control-group">
            <label>Source</label>
            <select v-model="selectedSourceId" @change="startStream">
              <template v-if="sourceType === 'screen'">
                <option v-for="s in screenSources" :key="s.id" :value="s.id">
                  {{ s.name }}
                </option>
              </template>
              <template v-else>
                <option v-for="w in webcamSources" :key="w.deviceId" :value="w.deviceId">
                  {{ w.label || `Camera ${w.deviceId}` }}
                </option>
              </template>
            </select>
            <button class="refresh-btn" @click="fetchSources">🔄</button>
          </div>

          <div class="control-group">
            <label>Model</label>
            <input
              v-model="modelId"
              placeholder="e.g. google/gemma-4-E2B-it"
              style="width: 200px"
              readonly
            />
          </div>

          <button :disabled="isLoading" @click="loadModel">Load Model</button>
        </div>

        <div class="control-row">
          <div class="control-group prompt-group">
            <label>Prompt</label>
            <textarea
              v-model="promptText"
              placeholder="Prompt..."
              class="prompt-textarea"
            ></textarea>
            <button class="reset-btn" title="Restore default prompt" @click="resetPrompt">⎌</button>
          </div>

          <div class="action-buttons">
            <button :disabled="!isModelLoaded || isLoading" @click="captureAndAnalyze">
              Capture & Analyze
            </button>
            <button
              :disabled="!isModelLoaded"
              :style="isModelLoaded ? { background: isStreaming ? '#ff4757' : '#2ed573' } : {}"
              @click="toggleStreaming"
            >
              {{ isStreaming ? 'Stop Live' : 'Start Live Analysis' }}
            </button>
          </div>
        </div>
      </div>
      <div class="status">
        {{ modelStatus }}
        <div v-if="loadProgress > 0 && loadProgress < 100" class="progress-bar-container">
          <div class="progress-bar" :style="{ width: loadProgress + '%' }"></div>
        </div>
      </div>
    </header>

    <div class="main-content">
      <div class="video-container">
        <!-- eslint-disable-next-line vue/html-self-closing -->
        <video ref="videoRef"></video>

        <!-- Selection Box Overlay -->
        <div
          class="crop-box"
          :style="{
            left: cropBox.x + 'px',
            top: cropBox.y + 'px',
            width: cropBox.width + 'px',
            height: cropBox.height + 'px'
          }"
          @mousedown="onBoxMouseDown"
        >
          <div class="resize-handle" @mousedown="onHandleMouseDown"></div>
        </div>
      </div>

      <div class="sidebar">
        <div class="sidebar-header">
          <h3>Analysis Result</h3>
          <div class="sidebar-actions">
            <button class="clear-btn" :disabled="!resultText || isLoading" @click="clearResult">
              Clear
            </button>
            <button class="copy-btn" :disabled="!resultText || isLoading" @click="copyToClipboard">
              {{ isCopied ? 'Copied!' : 'Copy Result' }}
            </button>
            <button class="save-btn" :disabled="!resultText || isLoading" @click="saveToFile">
              {{ isSaved ? 'Saved!' : 'Save' }}
            </button>
          </div>
        </div>
        <div class="result-container">
          <pre ref="resultRef" class="result">{{ resultText }}</pre>
          <div v-if="isLoading" class="loading-indicator">Processing...</div>
        </div>

        <div class="streaming-config">
          <div class="config-row">
            <label class="checkbox-label">
              <input v-model="isStreamingToFile" type="checkbox" />
              Stream to File
            </label>
            <button
              class="select-path-btn"
              :title="streamingFilePath || 'No file selected'"
              @click="selectStreamingFile"
            >
              {{ streamingFilePath ? 'Change File' : 'Select File' }}
            </button>
          </div>
          <div v-if="streamingFilePath" class="path-display" :title="streamingFilePath">
            {{ streamingFilePath }}
          </div>
        </div>

        <!-- Hidden canvas for cropping -->
        <canvas ref="canvasRef" style="display: none"></canvas>
      </div>
    </div>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  background-color: #f7f9fc;
  color: #333;
}
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.header {
  background: white;
  padding: 15px 20px;
  border-bottom: 1px solid #ddd;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}
.header h1 {
  margin: 0 0 10px 0;
  font-size: 20px;
}
.controls-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.control-row {
  display: flex;
  gap: 15px;
  align-items: center;
  flex-wrap: wrap;
}
.control-row:last-child {
  align-items: flex-start;
}
.action-buttons {
  display: flex;
  gap: 10px;
  align-self: flex-start;
  padding-top: 0;
}
.controls-container select,
.controls-container input,
.controls-container button,
.controls-container textarea {
  padding: 8px 12px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 14px;
}
.control-group {
  display: flex;
  align-items: center;
  gap: 5px;
}
.control-group label {
  font-size: 12px;
  font-weight: bold;
  color: #555;
  white-space: nowrap;
}
.prompt-group {
  flex: 1;
  min-width: 300px;
  align-items: flex-start !important;
}
.prompt-textarea {
  flex: 1;
  min-height: 42px;
  max-height: 150px;
  resize: vertical;
  padding: 8px 12px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.4;
}
.reset-btn {
  padding: 4px 10px !important;
  background: #f8f9fa !important;
  color: #333 !important;
  border: 1px solid #ccc !important;
  font-size: 16px !important;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.reset-btn:hover {
  background: #e9ecef !important;
}
.refresh-btn {
  padding: 4px 8px !important;
  background: #f8f9fa !important;
  color: #333 !important;
  border: 1px solid #ccc !important;
}
.controls-container button {
  background: #007bff;
  color: white;
  border: none;
  cursor: pointer;
  transition:
    background 0.2s,
    transform 0.1s;
}
.controls-container button:active {
  transform: translateY(1px);
}
.controls-container button:hover:not(:disabled) {
  background: #0056b3;
}
.controls-container button:disabled {
  background: #aaa;
  cursor: not-allowed;
}
.status {
  margin-top: 10px;
  font-size: 13px;
  color: #666;
}
.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
  padding: 20px;
  gap: 20px;
}
.video-container {
  flex: 2;
  position: relative;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.video-container video {
  max-width: 100%;
  max-height: 100%;
  pointer-events: none; /* Let events pass to crop block if needed, but here actually we position absolute */
}
.crop-box {
  position: absolute;
  border: 3px dashed #00ff00;
  background: rgba(0, 255, 0, 0.1);
  cursor: move;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
  /* The shadow dims everything OUTSIDE the box */
}
.resize-handle {
  position: absolute;
  right: -5px;
  bottom: -5px;
  width: 15px;
  height: 15px;
  background: #ff0000;
  border-radius: 50%;
  cursor: se-resize;
}
.sidebar {
  flex: 1;
  background: white;
  border-radius: 8px;
  padding: 15px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
}
.sidebar h3 {
  margin: 0;
}
.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.sidebar-actions {
  display: flex;
  gap: 8px;
}
.clear-btn {
  background: #6c757d !important;
  color: white;
  border: none;
  padding: 4px 8px !important;
  font-size: 12px !important;
  cursor: pointer;
  border-radius: 4px;
}
.clear-btn:disabled {
  background: #ccc !important;
  cursor: not-allowed;
}
.copy-btn {
  background: #28a745 !important;
  color: white;
  border: none;
  padding: 4px 8px !important;
  font-size: 12px !important;
  cursor: pointer;
  border-radius: 4px;
}
.copy-btn:disabled {
  background: #ccc !important;
  cursor: not-allowed;
}
.save-btn {
  background: #007bff !important;
  color: white;
  border: none;
  padding: 4px 8px !important;
  font-size: 12px !important;
  cursor: pointer;
  border-radius: 4px;
}
.save-btn:disabled {
  background: #ccc !important;
  cursor: not-allowed;
}
.result-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  min-height: 0;
}
.result {
  flex: 1;
  background: #f1f3f5;
  padding: 10px;
  border-radius: 6px;
  overflow: auto;
  font-size: 13px;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
}
.loading-indicator {
  position: absolute;
  bottom: 10px;
  right: 20px;
  background: rgba(255, 255, 255, 0.8);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  color: #007bff;
  font-weight: bold;
}
.loading {
  color: #007bff;
  font-weight: bold;
}
.progress-bar-container {
  width: 100%;
  height: 4px;
  background: #eee;
  border-radius: 2px;
  margin-top: 5px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: #007bff;
  transition: width 0.3s ease;
}
</style>
