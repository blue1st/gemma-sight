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
      const { promptText, dataUrl } = payload
      const rawImage = await RawImage.fromURL(dataUrl)

      const messages = [
        {
          role: 'user',
          content: [{ type: 'image' }, { type: 'text', text: promptText }]
        }
      ]

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prompt = await (processor as any).apply_chat_template(messages, {
        enable_thinking: false,
        add_generation_prompt: true
      })

      const inputs = await processor(prompt, rawImage, null, {
        add_special_tokens: false
      })

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
