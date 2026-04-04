import {
  env,
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  RawImage,
  TextStreamer,
  type Processor,
  type PreTrainedModel,
  type PreTrainedTokenizer
} from '@huggingface/transformers'

env.allowLocalModels = false

let processor: Processor | null = null
let model: PreTrainedModel | null = null

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data

  if (type === 'load') {
    try {
      const { modelId } = payload
      processor = (await AutoProcessor.from_pretrained(modelId)) as Processor
      model = (await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
        dtype: 'q4f16',
        device: 'webgpu',
        progress_callback: (info: Record<string, unknown>) => {
          self.postMessage({ type: 'progress', payload: info })
        }
      })) as PreTrainedModel
      self.postMessage({ type: 'loaded' })
    } catch (error: unknown) {
      console.error(error)
      const message = error instanceof Error ? error.message : String(error)
      self.postMessage({ type: 'error', error: message })
    }
  } else if (type === 'generate') {
    try {
      if (!processor || !model) {
        throw new Error('Model or processor not loaded')
      }
      const { promptText, dataUrl, audioData, samplingRate } = payload
      const rawImage = await RawImage.fromURL(dataUrl)

      if (audioData) {
        const sum = audioData.reduce((acc: number, val: number) => acc + Math.abs(val), 0)
        console.log('Audio data received in worker:', {
          length: audioData.length,
          avgAmplitude: sum / audioData.length,
          samplingRate
        })
      }

      const messages = [
        {
          role: 'user',
          content: [
            { type: 'image' },
            ...(audioData ? [{ type: 'audio' }] : []), // Template doesn't need data
            { type: 'text', text: promptText }
          ]
        }
      ]

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let prompt = await (processor as any).apply_chat_template(messages, {
        add_generation_prompt: true
      })

      console.log('Generated prompt:', prompt)

      // Manual fallback insertion if template skips them (some templates only support text)
      if (audioData && !prompt.includes('<audio>') && !prompt.includes('<boa>')) {
        console.warn('Audio marker missing in generated prompt, adding manually.')
        if (prompt.includes('<image>')) {
          prompt = prompt.replace('<image>', '<image><audio>')
        } else if (prompt.includes('<boi>')) {
          prompt = prompt.replace('<eoi>', '<eoi><audio>')
        } else {
          prompt = '<audio>' + prompt
        }
      }

      const inputs = await processor(prompt, rawImage, audioData, {
        add_special_tokens: false,
        sampling_rate: samplingRate
      })

      console.log('Prepared inputs keys:', Object.keys(inputs))

      const streamer = new TextStreamer(processor.tokenizer as PreTrainedTokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => {
          self.postMessage({ type: 'chunk', payload: text })
        }
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outputs = await (model as any).generate({
        ...inputs,
        max_new_tokens: 512,
        do_sample: false,
        streamer
      })

      const decoded = processor.batch_decode(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outputs.slice(null, [(inputs as any).input_ids.dims.at(-1), null]),
        { skip_special_tokens: true }
      )
      self.postMessage({ type: 'generated', payload: decoded[0] })
    } catch (error: unknown) {
      console.error(error)
      const message = error instanceof Error ? error.message : String(error)
      self.postMessage({ type: 'error', error: message })
    }
  }
}
