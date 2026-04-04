<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue'

interface ScreenSource {
  id: string
  name: string
  display_id: string
}

const sourceType = ref<'screen' | 'webcam' | 'video'>('screen')
const selectedSourceId = ref<string>('')
const selectedAudioSourceId = ref<string>('')
const screenSources = ref<ScreenSource[]>([])
const webcamSources = ref<MediaDeviceInfo[]>([])
const audioSources = ref<MediaDeviceInfo[]>([])
const includeAudio = ref(false)
const videoRef = ref<HTMLVideoElement | null>(null)
const videoFilePath = ref('')
const canvasRef = ref<HTMLCanvasElement | null>(null)

// Crop Box State
const cropBox = ref({ x: 50, y: 50, width: 200, height: 150 })
const isDragging = ref(false)
const isResizing = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const initialBox = ref({ x: 0, y: 0, width: 0, height: 0 })

const modelId = ref('onnx-community/gemma-4-E2B-it-ONNX')
const DEFAULT_PROMPT = 'Describe this image in Japanese. 1-2 sentences.'
const DEFAULT_MULTIMODAL_PROMPT = 'Describe this image and audio in Japanese. 1-2 sentences.'
const promptText = ref(DEFAULT_PROMPT)

// Sampling Interval (ms)
const DEFAULT_INTERVAL = 2000
const samplingInterval = ref(DEFAULT_INTERVAL)

function resetPrompt(): void {
  promptText.value = DEFAULT_PROMPT
}

function resetInterval(): void {
  samplingInterval.value = DEFAULT_INTERVAL
}

const resultText = ref('')
const isLoading = ref(false)
const modelStatus = ref('Ready to load')
const loadProgress = ref(0)
const isCopied = ref(false)
const isSaved = ref(false)

// Notification feature
const enableNotification = ref(false)
const notifyPattern = ref('')

interface NotifyLogEntry {
  timestamp: string
  matched: string
  text: string
}
const notifyLog = ref<NotifyLogEntry[]>([])
let currentStreamTimestamp = '' // Tracks the timestamp of the current live capture

function checkAndNotify(text: string): void {
  if (!enableNotification.value || !notifyPattern.value) return
  try {
    const regex = new RegExp(notifyPattern.value)
    const match = text.match(regex)
    if (match) {
      // Always log the match regardless of cooldown
      const timestamp =
        isStreaming.value && currentStreamTimestamp
          ? currentStreamTimestamp
          : new Date().toLocaleTimeString()
      const entry = {
        timestamp,
        matched: match[0],
        text: text.substring(0, 200)
      }
      notifyLog.value.push(entry)
      // Forward to log window
      window.electron.ipcRenderer.invoke('add-notify-log-entry', entry)
    }
  } catch {
    // Invalid regex – silently ignore
  }
}

function openLogWindow(): void {
  window.electron.ipcRenderer.invoke('open-notify-log-window')
}

const isStreamingToFile = ref(false)
const streamingFilePath = ref('')
const isStreaming = ref(false)
const isModelLoaded = ref(false)
const resultRef = ref<HTMLPreElement | null>(null)
let audioContext: AudioContext | null = null
let audioStream: MediaStream | null = null
const audioBuffer = ref<Float32Array | null>(null)
const audioVolume = ref(0)
const audioStatus = ref('')
let writeIdx = 0
let animationFrameId: number | null = null

async function startAudioCapture(): Promise<void> {
  if (audioContext) {
    audioContext.close()
  }
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: selectedAudioSourceId.value
        ? { deviceId: { exact: selectedAudioSourceId.value } }
        : true,
      video: false
    })

    console.log('Audio stream obtained:', {
      active: audioStream.active,
      tracks: audioStream.getAudioTracks().map((t) => ({ label: t.label, enabled: t.enabled }))
    })

    audioContext = new AudioContext() // Default sample rate
    audioStatus.value = `Running (${audioContext.sampleRate}Hz)`

    const source = audioContext.createMediaStreamSource(audioStream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    const processorNode = audioContext.createScriptProcessor(4096, 1, 1)

    // Scaling buffer for 3 seconds of audio regardless of sample rate
    const totalSamples = audioContext.sampleRate * 3
    const internalBuffer = new Float32Array(totalSamples)
    writeIdx = 0

    processorNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      for (let i = 0; i < input.length; i++) {
        internalBuffer[writeIdx] = input[i]
        writeIdx = (writeIdx + 1) % totalSamples
      }
      audioBuffer.value = internalBuffer
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const updateVolume = (): void => {
      analyser.getByteFrequencyData(dataArray)
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i]
      }
      audioVolume.value = Math.min(100, (sum / dataArray.length) * 2)
      animationFrameId = requestAnimationFrame(updateVolume)
    }

    source.connect(analyser)
    source.connect(processorNode)
    processorNode.connect(audioContext.destination)
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }
    updateVolume()
  } catch (err) {
    console.error('Failed to start audio capture:', err)
    audioStatus.value = `Error: ${err instanceof Error ? err.name : 'Unknown'}`
    if (String(err).includes('NotAllowedError')) {
      audioStatus.value = 'Microphone access denied. Please grant permission.'
    }
  }
}

watch([includeAudio, selectedAudioSourceId], async () => {
  if (includeAudio.value) {
    await startAudioCapture()
    if (promptText.value === DEFAULT_PROMPT) {
      promptText.value = DEFAULT_MULTIMODAL_PROMPT
    }
  } else if (audioContext) {
    if (promptText.value === DEFAULT_MULTIMODAL_PROMPT) {
      promptText.value = DEFAULT_PROMPT
    }
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
    }
    audioContext.close()
    audioContext = null
    audioStream?.getTracks().forEach((t) => t.stop())
    audioVolume.value = 0
  }
})

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
          checkAndNotify(payload)
          if (isStreamingToFile.value && streamingFilePath.value) {
            window.electron.ipcRenderer.invoke('append-to-file', {
              filePath: streamingFilePath.value,
              content: payload + '\n'
            })
          }
        } else {
          // In streaming mode, chunks already populated resultText.
          // We just add a double newline to separate from next capture.
          checkAndNotify(payload)
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
          }, samplingInterval.value)
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

  // Fetch webcam and audio sources
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    webcamSources.value = devices.filter((device) => device.kind === 'videoinput')
    audioSources.value = devices.filter((device) => device.kind === 'audioinput')
  } catch (err) {
    console.error('Failed to get media devices:', err)
  }

  // Set default source if none selected
  if (!selectedAudioSourceId.value && audioSources.value.length > 0) {
    selectedAudioSourceId.value = audioSources.value[0].deviceId
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

async function selectVideoFile(): Promise<void> {
  const filePath = await window.electron.ipcRenderer.invoke('select-video-file')
  if (!filePath) return

  videoFilePath.value = filePath

  const video = videoRef.value
  if (!video) return

  // Stop any existing streams
  if (video.srcObject) {
    const stream = video.srcObject as MediaStream
    stream.getTracks().forEach((t) => t.stop())
    video.srcObject = null
  }

  // Use custom protocol registered in main process
  video.src = `local-video://${filePath}`
  video.load()
  console.log('Video src set to:', video.src)
}

// Debug: monitor video element events
watch(videoRef, (video) => {
  if (!video) return
  video.addEventListener('error', () => {
    const err = video.error
    console.error('Video error:', err?.code, err?.message)
  })
  video.addEventListener('loadeddata', () => {
    console.log('Video loadeddata: ready to play', video.videoWidth, 'x', video.videoHeight)
  })
  video.addEventListener('canplay', () => {
    console.log('Video canplay event fired')
  })
})

onMounted(async () => {
  await fetchSources()
  if (includeAudio.value) {
    startAudioCapture()
  }
  // Listen for clear events from the log window
  window.electron.ipcRenderer.on('notify-log-cleared', () => {
    notifyLog.value = []
  })
})

async function onSourceTypeChange(): Promise<void> {
  // Clean up previous video source
  if (videoRef.value) {
    videoRef.value.pause()
    videoRef.value.removeAttribute('src')
    videoRef.value.load()
  }

  selectedSourceId.value = ''
  if (sourceType.value === 'screen' && screenSources.value.length > 0) {
    selectedSourceId.value = screenSources.value[0].id
    startStream()
  } else if (sourceType.value === 'webcam' && webcamSources.value.length > 0) {
    selectedSourceId.value = webcamSources.value[0].deviceId
    startStream()
  }
}

async function startStream(): Promise<void> {
  const sourceId = selectedSourceId.value
  try {
    let stream: MediaStream
    if (sourceType.value === 'screen') {
      if (!sourceId) return
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // Drawing the cropped portion with scale correction for object-fit: contain (default)
  const video = videoRef.value
  const canvas = canvasRef.value
  if (!video || !canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    console.warn('Video not ready for capture')
    return
  }

  const vWidth = video.videoWidth
  const vHeight = video.videoHeight
  const cWidth = video.clientWidth
  const cHeight = video.clientHeight

  const videoAspect = vWidth / vHeight
  const elementAspect = cWidth / cHeight

  let actualWidth = cWidth
  let actualHeight = cHeight
  let marginLeft = 0
  let marginTop = 0

  if (elementAspect > videoAspect) {
    actualWidth = cHeight * videoAspect
    marginLeft = (cWidth - actualWidth) / 2
  } else {
    actualHeight = cWidth / videoAspect
    marginTop = (cHeight - actualHeight) / 2
  }

  const scaleX = vWidth / actualWidth
  const scaleY = vHeight / actualHeight

  const cropX = (cropBox.value.x - marginLeft) * scaleX
  const cropY = (cropBox.value.y - marginTop) * scaleY
  const cropW = cropBox.value.width * scaleX
  const cropH = cropBox.value.height * scaleY

  if (canvas) {
    canvas.width = cropW
    canvas.height = cropH
  }

  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)
  const dataUrl = canvas?.toDataURL('image/jpeg')

  isLoading.value = true
  if (isStreaming.value) {
    let timestamp: string
    if (sourceType.value === 'video' && video) {
      const t = video.currentTime
      const h = Math.floor(t / 3600)
        .toString()
        .padStart(2, '0')
      const m = Math.floor((t % 3600) / 60)
        .toString()
        .padStart(2, '0')
      const s = Math.floor(t % 60)
        .toString()
        .padStart(2, '0')
      const ms = Math.floor((t % 1) * 1000)
        .toString()
        .padStart(3, '0')
      timestamp = `${h}:${m}:${s}.${ms}`
    } else {
      timestamp = new Date().toLocaleTimeString()
    }
    currentStreamTimestamp = timestamp
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

  let audioData: Float32Array | null = null
  if (includeAudio.value && audioBuffer.value && audioContext) {
    const len = audioBuffer.value.length
    const rawBuffer = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      rawBuffer[i] = audioBuffer.value[(writeIdx + i) % len]
    }

    // Manual resample to 16kHz if needed
    if (audioContext.sampleRate !== 16000) {
      const offlineCtx = new OfflineAudioContext(1, len, audioContext.sampleRate)
      const buffer = offlineCtx.createBuffer(1, len, audioContext.sampleRate)
      buffer.copyToChannel(rawBuffer, 0)
      const source = offlineCtx.createBufferSource()
      source.buffer = buffer

      const targetRate = 16000
      const resampledLen = Math.floor(len * (targetRate / audioContext.sampleRate))
      const resampleOfflineCtx = new OfflineAudioContext(1, resampledLen, targetRate)
      const resampledSource = resampleOfflineCtx.createBufferSource()
      resampledSource.buffer = buffer
      resampledSource.connect(resampleOfflineCtx.destination)
      resampledSource.start(0)

      const resampledBuffer = await resampleOfflineCtx.startRendering()
      audioData = resampledBuffer.getChannelData(0)
    } else {
      audioData = rawBuffer
    }
  }

  worker?.postMessage({
    type: 'generate',
    payload: {
      promptText: promptText.value,
      dataUrl,
      audioData,
      samplingRate: 16000 // Always 16000 now
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
        <!-- Row 1: Source Type + Source -->
        <div class="control-row">
          <div class="control-row-left">
            <div class="control-group">
              <label>Source Type</label>
              <select v-model="sourceType" @change="onSourceTypeChange">
                <option value="screen">Screen / Window</option>
                <option value="webcam">WebCam</option>
                <option value="video">Video File</option>
              </select>
            </div>
          </div>
          <div class="control-row-right">
            <div v-if="sourceType !== 'video'" class="control-group">
              <label>Source</label>
              <select v-model="selectedSourceId" class="source-select" @change="startStream">
                <template v-if="sourceType === 'screen'">
                  <option v-for="s in screenSources" :key="s.id" :value="s.id">
                    {{ s.name }}
                  </option>
                </template>
                <template v-else-if="sourceType === 'webcam'">
                  <option v-for="w in webcamSources" :key="w.deviceId" :value="w.deviceId">
                    {{ w.label || `Camera ${w.deviceId}` }}
                  </option>
                </template>
              </select>
              <button class="refresh-btn" @click="fetchSources">🔄</button>
            </div>
            <div v-if="sourceType === 'video'" class="control-group">
              <label>Video File</label>
              <button class="load-btn" @click="selectVideoFile">
                {{ videoFilePath ? 'Change File' : 'Select File' }}
              </button>
              <span v-if="videoFilePath" class="video-file-name" :title="videoFilePath">
                {{ videoFilePath.split('/').pop() }}
              </span>
            </div>
          </div>
        </div>

        <!-- Row 2: Audio Source + Use Audio -->
        <div class="control-row">
          <div class="control-row-left">
            <div class="control-group">
              <label>Audio Source</label>
              <select v-model="selectedAudioSourceId">
                <option v-for="a in audioSources" :key="a.deviceId" :value="a.deviceId">
                  {{ a.label || `Audio ${a.deviceId}` }}
                </option>
              </select>
              <div v-if="includeAudio" class="volume-meter" title="Current Audio Level">
                <div
                  class="volume-level"
                  :style="{
                    width: audioVolume + '%',
                    background: audioVolume > 70 ? '#ff4757' : '#2ed573'
                  }"
                ></div>
              </div>
              <div v-if="audioStatus" class="audio-status-label">{{ audioStatus }}</div>
            </div>
          </div>
          <div class="control-row-right">
            <label class="checkbox-label">
              <input v-model="includeAudio" type="checkbox" />
              Use Audio
            </label>
          </div>
        </div>

        <!-- Row 3: Model + Load Model -->
        <div class="control-row">
          <div class="control-row-left">
            <div class="control-group">
              <label>Model</label>
              <input
                v-model="modelId"
                placeholder="e.g. google/gemma-4-E2B-it"
                class="model-input"
                readonly
              />
            </div>
          </div>
          <div class="control-row-right">
            <button class="load-btn" :disabled="isLoading" @click="loadModel">Load Model</button>
          </div>
        </div>

        <!-- Row 4: Prompt + Capture & Analyze -->
        <div class="control-row">
          <div class="control-row-left">
            <div class="control-group prompt-group">
              <label>Prompt</label>
              <textarea
                v-model="promptText"
                placeholder="Prompt..."
                class="prompt-textarea"
              ></textarea>
              <button class="reset-btn" title="Restore default prompt" @click="resetPrompt">
                ⎌
              </button>
            </div>
          </div>
          <div class="control-row-right">
            <button
              class="action-btn capture-btn"
              :disabled="!isModelLoaded || isLoading"
              :style="isModelLoaded ? { background: '#3867d6' } : {}"
              @click="captureAndAnalyze"
            >
              Capture & Analyze
            </button>
          </div>
        </div>

        <!-- Row 5: Live Interval + Start Live Analysis -->
        <div class="control-row">
          <div class="control-row-left">
            <div class="control-group">
              <label>Live Interval (ms)</label>
              <input
                v-model.number="samplingInterval"
                type="number"
                step="500"
                min="0"
                style="width: 100px"
              />
              <button class="reset-btn" title="Restore default interval" @click="resetInterval">
                ⎌
              </button>
            </div>
          </div>
          <div class="control-row-right">
            <button
              class="action-btn live-btn"
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
        <video ref="videoRef" :controls="sourceType === 'video'" playsinline></video>

        <!-- Selection Box Overlay (hidden in video file mode) -->
        <div
          v-if="sourceType !== 'video'"
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

        <div class="notification-config">
          <div class="config-row">
            <label class="checkbox-label">
              <input v-model="enableNotification" type="checkbox" />
              Regex Notify
            </label>
            <button v-if="enableNotification" class="open-log-btn" @click="openLogWindow">
              🔔 Open Log{{ notifyLog.length > 0 ? ` (${notifyLog.length})` : '' }}
            </button>
          </div>
          <div v-if="enableNotification" class="config-row">
            <input
              v-model="notifyPattern"
              type="text"
              placeholder="e.g. 異常|エラー|alert"
              class="notify-pattern-input"
            />
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
.controls-container select,
.controls-container input,
.controls-container button,
.controls-container textarea {
  padding: 8px 12px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 14px;
}
.control-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 15px;
  align-items: center;
}
.control-row-left {
  display: flex;
  align-items: center;
  min-width: 0;
}
.control-row-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.control-group {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.control-group label {
  font-size: 12px;
  font-weight: bold;
  color: #555;
  white-space: nowrap;
}
.source-select {
  min-width: 150px;
  max-width: 300px;
}
.model-input {
  width: 280px;
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
  align-self: stretch;
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
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
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
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #444;
  cursor: pointer;
  user-select: none;
}
.checkbox-label input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.volume-meter {
  width: 60px;
  height: 8px;
  background: #eee;
  border-radius: 4px;
  overflow: hidden;
  margin-left: 5px;
  border: 1px solid #ddd;
}
.volume-level {
  height: 100%;
  transition:
    width 0.1s,
    background 0.2s;
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
  box-shadow: none !important;
  transform: none !important;
}
.action-btn {
  height: 48px; /* Increased height */
  padding: 0 24px !important;
  min-width: 240px; /* Standardize width */
  font-weight: 700 !important;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  box-shadow: 0 4px 0 rgba(0, 0, 0, 0.15);
  transition: all 0.1s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 4px solid rgba(0, 0, 0, 0.2) !important;
}
.action-btn:active:not(:disabled) {
  transform: translateY(2px);
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.15);
  border-bottom-width: 2px !important;
}
.load-btn {
  background: #00a8ff !important; /* Brighter blue */
  color: white;
  border: none;
  cursor: pointer;
}
.load-btn:hover:not(:disabled) {
  background: #0097e6 !important;
}
.capture-btn:hover:not(:disabled) {
  background: #2d5a9e !important;
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
}
.video-container video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  position: relative;
  z-index: 1;
}
.crop-box {
  position: absolute;
  z-index: 2;
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
.video-file-name {
  font-size: 12px;
  color: #666;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.notification-config {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #eee;
}
.notification-config .config-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.notify-pattern-input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 13px;
  font-family: monospace;
}
.notify-pattern-input:focus {
  border-color: #007bff;
  outline: none;
  box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.15);
}
.open-log-btn {
  background: #16213e !important;
  color: #53d8fb !important;
  border: 1px solid #0f3460 !important;
  padding: 4px 10px !important;
  font-size: 12px !important;
  cursor: pointer;
  border-radius: 4px;
  white-space: nowrap;
}
.open-log-btn:hover {
  background: #0f3460 !important;
}
</style>
