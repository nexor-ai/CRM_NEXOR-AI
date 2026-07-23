import { AiError } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
}

export async function generateOpenRouter(args: ProviderArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args;
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer':
          process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3010',
        'X-Title': 'NEXOR AI CRM',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }
  if (!res.ok) throw await providerHttpError('OpenRouter', res);
  const data = (await res
    .json()
    .catch(() => null)) as OpenRouterResponse | null;
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenRouter returned an empty response.', {
      code: 'empty_response',
    });
  }
  return text;
}
