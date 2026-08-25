import { getAssetFromKV } from '@cloudflare/kv-asset-handler'
import manifestJSON from '__STATIC_CONTENT_MANIFEST'

const assetManifest = JSON.parse(manifestJSON)

const UPSTREAM_BASE_URL = 'https://api.agnes-ai.cn/v1'
const DEFAULT_MODEL = 'agnes-2.5-flash'

interface Env {
  AGNES_API_KEY: string
  CORS_ORIGIN: string
  __STATIC_CONTENT: KVNamespace
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) })
    }

    // API route
    if (url.pathname === '/api/chat') {
      return handleChat(req, env)
    }

    // Static assets
    try {
      return await getAssetFromKV(
        { request: req, waitUntil: ctx.waitUntil.bind(ctx) },
        {
          ASSET_NAMESPACE: env.__STATIC_CONTENT,
          ASSET_MANIFEST: assetManifest,
        },
      )
    } catch {
      // SPA fallback: return index.html for any non-API, non-asset route
      try {
        const notFoundReq = new Request(url.toString(), req)
        return await getAssetFromKV(
          { request: notFoundReq, waitUntil: ctx.waitUntil.bind(ctx) },
          {
            ASSET_NAMESPACE: env.__STATIC_CONTENT,
            ASSET_MANIFEST: assetManifest,
            mapRequestToAsset: (request) => {
              const parsedUrl = new URL(request.url)
              parsedUrl.pathname = '/index.html'
              return new Request(parsedUrl.toString(), request)
            },
          },
        )
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }
  },
}

async function handleChat(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed', env)
  }

  const apiKey = env.AGNES_API_KEY
  if (!apiKey) {
    return jsonError(500, 'AGNES_API_KEY 环境变量未配置,请在 Cloudflare Dashboard 设置', env)
  }

  let body: {
    messages: unknown
    temperature?: number
    max_tokens?: number
    model?: string
  }

  try {
    body = await req.json()
  } catch {
    return jsonError(400, '请求体不是有效的 JSON', env)
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return jsonError(400, 'messages 字段缺失或非数组', env)
  }

  const upstreamUrl = `${UPSTREAM_BASE_URL.replace(/\/+$/, '')}/chat/completions`

  const upstreamResponse = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: body.model || DEFAULT_MODEL,
      messages: body.messages,
      temperature: body.temperature ?? 0.8,
      max_tokens: body.max_tokens ?? 2048,
      stream: true,
    }),
  })

  if (!upstreamResponse.ok) {
    const errText = await upstreamResponse.text().catch(() => upstreamResponse.statusText)
    return jsonError(upstreamResponse.status, `AI API 请求失败: ${errText}`, env)
  }

  if (!upstreamResponse.body) {
    return jsonError(502, 'AI API 响应无 body(不支持流式)', env)
  }

  return new Response(upstreamResponse.body, {
    status: 200,
    headers: {
      ...corsHeaders(env),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function jsonError(status: number, message: string, env: Env): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...corsHeaders(env),
      'Content-Type': 'application/json',
    },
  })
}
