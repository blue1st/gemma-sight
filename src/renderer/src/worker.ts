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
      const { promptText, dataUrls, audioData, samplingRate } = payload
      const images = await Promise.all(
        dataUrls.map((url: string) => RawImage.fromURL(url))
      )

      if (audioData) {
        const sum = audioData.reduce((acc: number, val: number) => acc + Math.abs(val), 0)
        console.log('Audio data received in worker:', {
          length: audioData.length,
          avgAmplitude: sum / audioData.length,
          samplingRate
        })
      }

      // Construct content following the suggested pattern: Media -> Audio -> Text
      const content: any[] = []
      
      // Use individual image placeholders if multiple frames are provided, 
      // as some templates/versions of transformers.js might not expand 'type: video' correctly.
      if (images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          content.push({ type: 'image' })
        }
      }

      if (audioData) {
        content.push({ type: 'audio' })
      }

      content.push({ type: 'text', text: promptText })

      const messages = [
        {
          role: 'user',
          content
        }
      ]

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let prompt = await (processor as any).apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: false
      })

      console.log('Template output:', prompt)

      // Ensure media placeholders are present. 
      // We look for common markers like <image>, <audio>, <video>, or [IMAGE]
      // Handle special tokens for media. Some tokenizers use unique tags.
      const imageTag = (processor as any).image_token || '<image>'
      const audioTag = (processor as any).audio_token || '<audio>'
      const videoTag = '<video>'

      const hasImageToken = prompt.includes(imageTag) || prompt.includes('<boi>') || prompt.includes('[IMAGE]')
      const hasAudioToken = prompt.includes(audioTag) || prompt.includes('<boa>') || prompt.includes('[AUDIO]')
      const hasVideoToken = prompt.includes(videoTag) || prompt.includes('[VIDEO]')

      if (images.length > 0 && !hasImageToken && !hasVideoToken) {
        console.warn(`Media tokens missing in prompt, prefixing with ${images.length}x ${imageTag}`)
        const placeholders = imageTag.repeat(images.length)
        prompt = prompt.replace(/(<start_of_turn>user\s*)/, `$1\n${placeholders}\n`)
      }

      if (audioData && !hasAudioToken) {
        console.warn(`Audio token missing in prompt, prefixing with ${audioTag}`)
        if (prompt.includes(imageTag)) {
          prompt = prompt.replace(imageTag, `${imageTag}${audioTag}`)
        } else {
          prompt = prompt.replace(/(<start_of_turn>user\s*)/, `$1\n${audioTag}\n`)
        }
      }

      console.log('Final prompt for tokenizer:', prompt)

      const inputs = await (processor as any)(prompt, images, audioData, {
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
