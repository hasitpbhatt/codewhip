# CodeWhip Proxy Library

## Overview

An OpenAI-compatible proxy library with smart routing for LLM providers, designed to run in Cloudflare Workers or as an npm package. This is an **add-on** to CodeWhip that extracts the proxy functionality for external use.

## What This Is

This README documents **CodeWhip Proxy**, the extracted proxy library that can be used independently from the main CodeWhip CLI. The existing CodeWhip CLI (`codewhip serve`, `codewhip run`, etc.) continues to work exactly as before.

CodeWhip Proxy provides:

- **Cloudflare Workers deployment** - Serverless OpenAI-compatible API
- **NPM package** - Programmatic API for embedding in Node.js applications
- **Smart provider routing** - Health-weighted selection across 35+ providers
- **Authentication & key management** - Bearer tokens, environment variables, stored keys
- **OpenAI API compatibility** - Full protocol support including streaming

## Quick Start

### Using CodeWhip Proxy as an NPM package

```bash
npm install @codewhip/proxy
```

```typescript
import { createProxy, createStorageForBackend } from '@codewhip/proxy';

// Create storage backend (Node.js)
const storage = createStorageForBackend('node');

// Create proxy
const proxy = createProxy({
  provider: "auto",
  model: "auto",
  token: process.env.PROXY_TOKEN,
  storage
});

// Handle requests
const response = await proxy.handle(request);
```

### Using in Cloudflare Workers

```toml
# wrangler.toml
name = "codewhip-proxy"
main = "workers/src/index.ts"

[vars]
BEARER_TOKEN = ""

[[kv_namespaces]]
binding = "PROXY_STORAGE"
id = "your-kv-namespace-id"
```

```typescript
// workers/src/index.ts
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const { createProxy, createStorageForBackend } = await import("../src/lib/index.js");
    
    const storage = createStorageForBackend("kv", env.PROXY_STORAGE);
    
    const proxy = createProxy({
      provider: "auto",
      model: "auto",
      token: env.BEARER_TOKEN,
      storage
    });
    
    return proxy.handle(request);
  }
};
```

### Using the Original CodeWhip CLI

The existing CodeWhip CLI continues to work unchanged:

```bash
# Start the proxy server
codewhip serve --port 8080 --host 127.0.0.1

# With authentication
codewhip serve --port 8080 --token your-secret-token

# Run the agent
codewhip run "fix the failing test" --free
codewhip auth login nvidia
codewhip run "fix the failing test"
```

## API Reference

### Core Functions

#### `createProxy(options)`
Creates a new proxy instance.

**Parameters:**
- `options: ServeOptions` - Proxy configuration options

**Returns:**
- Proxy instance with `handle()`, `resolveTarget()`, and `pickAutoTarget()` methods

#### `createStorageForBackend(backend, kv?)`
Creates a storage instance for the specified backend.

**Parameters:**
- `backend: "kv" | "node"` - Storage backend
- `kv?` - Cloudflare KV binding (required for "kv" backend)

**Returns:**
- Storage instance

### Types

- `ServeOptions` - Proxy configuration
- `Storage` - Abstract storage interface
- `ProviderConfig` - Provider configuration
- `Target` - Provider/model target
- `LoopMsg` - Internal message format
- `ToolSpec` - Tool specification

## Architecture

### Core Library (`src/lib/`)

The proxy library is organized into platform-agnostic modules:

- **`types.ts`** - Core type definitions
- **`storage.ts`** - Storage abstraction layer (KV vs filesystem)
- **`providers.ts`** - Provider registry (35+ builtin providers)
- **`openai.ts`** - OpenAI protocol conversion utilities
- **`proxy.ts`** - Core proxy logic (request handling, routing, validation)
- **`index.ts`** - Exported API surface

### Cloudflare Workers (`workers/`)

- **`src/index.ts`** - Workers entry point
- **`wrangler.toml`** - Cloudflare configuration
- Uses KV for storage, fetch API for HTTP handling

### NPM Package (`package.json`)

- **`exports` field** - Multi-entrypoint package.json
- **`dist/lib/`** - Compiled TypeScript library
- **ESM-only** - Modern JavaScript with types

## Provider Registry

CodeWhip Proxy includes the same 35+ builtin providers as the CLI:

### Key Providers

| Provider | Description | Default Model | Free Tier? |
|----------|-------------|---------------|-----------|
| nvidia | NVIDIA-hosted open models | `meta/llama-3.1-405b-instruct` | ✅ $0 |
| openai | OpenAI GPT models | `gpt-4o-mini` | ❌ Requires key |
| gemini | Google Gemini models | `gemini-1.5-flash` | ❌ Requires key |
| mistral | Mistral AI models | `mistral-large-latest` | ❌ Requires key |
| cloudflare | Cloudflare Workers AI | `@cf/metallama/llama-2-7b-chat-fp16` | ✅ Free-key |
| groq | Groq open models | `llama-3.1-70b-versatile` | ✅ Free-key |

And 25+ more including Anthropic, Cohere, Hugging Face, Together AI, Perplexity, and more.

### Provider Configuration

Each provider has:

- `id` - Provider identifier
- `brand` - Display name
- `baseUrl` - API base URL
- `chatPath` - Chat completions endpoint
- `modelsPath` - Models listing endpoint
- `defaultModel` - Default model
- `envVar` - Environment variable for API key
- `keyUrl` - URL to get API key
- `timeoutMs` - Request timeout
- `rateLimitedHint` - Rate limiting information

## Smart Routing

### Auto Provider Selection

When `provider: "auto"` and `model: "auto"` are used, the proxy applies:

1. **Cost weighting** - Free providers get 3x weight, priced get 1x
2. **Health weighting** - `(0.5 + successRate)` - proven providers get higher weight
3. **TTL deactivation** - Recently failed providers are automatically excluded
4. **Eligibility checking** - Only free/active providers are considered

### Model Resolution

- **`provider:model` syntax** - Explicit routing (`nvidia:gpt-4o-mini`)
- **Bare provider** - Uses provider's default model (`nvidia`)
- **Bare model** - Uses server's default provider (`gpt-4o-mini`)
- **`auto`** - Smart selection based on health and eligibility

## OpenAI API Compatibility

### Supported Endpoints

- `POST /v1/chat/completions` - Chat completions with streaming support
- `GET /v1/models` - Lists all providers as `<provider>:<default-model>`
- `GET /health` - Health check endpoint (no authentication required)

### Streaming Support

Clients can request streaming (`"stream": true`) and the proxy will:

1. Synthesize SSE streams from non-streaming upstream providers
2. Maintain OpenAI-compatible SSE format
3. Include usage statistics in streaming responses
4. Handle both streaming and non-streaming clients transparently

## Authentication

### Bearer Token Authentication

```typescript
createProxy({
  provider: "auto",
  model: "auto",
  token: "your-secret-bearer-token",  // Optional
  // ... other options
})
```

All requests except `/health` require a valid bearer token when configured.

### Key Resolution

The proxy supports multiple key sources:

1. **Environment variables** - `NVIDIA_API_KEY`, `OPENAI_API_KEY`, etc.
2. **Stored keys** - Encrypted filesystem storage (Node.js) or KV (Cloudflare)
3. **Anonymous keys** - Built-in anonymous keyless tiers (kilo, opencode, etc.)

## Storage Backends

### Node.js (File System)

- **CLI mode**: Uses the same storage as the CodeWhip CLI
- **Credentials**: `~/.codewhip/credentials.json` for stored API keys
- **Providers**: `~/.codewhip/custom-providers.json` for custom provider configs
- **Permissions**: Owner-only file permissions (0o600)

### Cloudflare Workers (KV)

- **KV binding**: `PROXY_STORAGE` for all persistent data
- **Key-value pairs**: Provider configs, API keys, provider stats
- **Automatic TTL**: Expiration for temporary data
- **Strong consistency**: Durable Object-backed where needed

## Security

### Authentication

- Bearer token required for all non-health endpoints when configured
- Environment variables win over stored keys (CI-friendly)
- No plaintext keys logged or leaked

### Access Control

- **Loopback binding**: Binds to 127.0.0.1 by default
- **Token requirement**: Non-loopback binds require `--token` (Cloudflare) or bearer token (NPM)
- **Provider restrictions**: Private prompts route only to registered loopback providers

## Performance

### Smart Selection Algorithm

```
weight = costFactor × healthFactor
- costFactor: free providers ×3, priced ×1, untracked ×0.5
- healthFactor: no history ×1.5, or 0.5 + successRate
```

### Request Processing

- **Connection pooling**: Reuse HTTP connections to upstream providers
- **Request timeout**: Configurable per-provider timeouts (default 30s)
- **Error recovery**: Automatic retry on 429, failover on other errors
- **Streaming synthesis**: Seamless streaming from non-streaming upstreams

## Testing

### Library Tests

```bash
# Run all library tests
npm run test:lib

# Run specific test file
npm test src/lib/**/*.test.ts
```

### Cloudflare Workers Tests

```bash
# Deploy to Workers playground for integration testing
wrangler dev
```

## Deployment

### Cloudflare Workers

```bash
# Deploy to Cloudflare Workers
npm run deploy

# Local development
npm run deploy:dev
```

### NPM Package

```bash
# Publish to npm (maintainers only)
npm publish
```

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PROXY_TOKEN` | Bearer token for authentication |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (for Cloudflare provider) |

### Storage Configuration

```typescript
createProxy({
  provider: "auto",
  model: "auto",
  storage: createStorageForBackend("node"),  // or "kv" for Cloudflare
  // ... other options
})
```

## Development

### Building

```bash
# Build all code
npm run build

# Build just the library
npm run build:lib

# Typecheck all code
npm run typecheck

# Typecheck just the library
npm run typecheck:lib

# Run tests
npm test

# Run library tests only
npm run test:lib
```

### Running Tests

The library includes comprehensive tests covering:

- Provider resolution and routing
- OpenAI API compatibility
- Error handling and validation
- Authentication and key management
- Performance and streaming

Run all tests:

```bash
npm test
```

Run library tests only:

```bash
npm run test:lib
```

### GitHub Actions

The library includes GitHub Actions for CI/CD:

- **Type checking** - Ensures type safety
- **Testing** - Runs all test suites
- **Build** - Compiles TypeScript
- **Cloudflare deployment** - Deploys to Cloudflare Workers on merge

## Examples

### Example 1: Basic Proxy Setup

```typescript
import { createProxy, createStorageForBackend } from '@codewhip/proxy';

const storage = createStorageForBackend('node');

const proxy = createProxy({
  provider: "auto",
  model: "auto",
  storage
});

// Handle an OpenAI API request
const response = await proxy.handle(new Request('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: "openai:gpt-4o-mini",
    messages: [{ role: "user", content: "Hello" }]
  })
}));
```

### Example 2: Cloudflare Workers Integration

```typescript
// workers/src/index.ts
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const { createProxy, createStorageForBackend } = await import("../src/lib/index.js");
    
    const storage = createStorageForBackend("kv", env.PROXY_STORAGE);
    
    const proxy = createProxy({
      provider: "auto",
      model: "auto",
      token: env.BEARER_TOKEN,
      authUi: true,
      storage
    });
    
    return proxy.handle(request);
  }
};
```

### Example 3: Smart Provider Selection

```typescript
import { createProxy, createStorageForBackend } from '@codewhip/proxy';

const storage = createStorageForBackend('node');

const proxy = createProxy({
  provider: "auto",      // Let proxy choose best provider
  model: "auto",         // Let proxy choose best model
  token: process.env.PROXY_TOKEN,
  storage
});

// Client sends request with just model - proxy handles provider selection
const response = await proxy.handle(new Request('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: "gpt-4o-mini",  // Proxy selects nvidia:gpt-4o-mini
    messages: [{ role: "user", content: "Hello" }]
  })
}));
```

## Migration

### From CodeWhip CLI to CodeWhip Proxy

If you're migrating from the CodeWhip CLI to the proxy library:

1. **Replace `codewhip serve` with proxy library** - The CLI continues to work but the library provides more flexibility for embedding
2. **Storage changes** - KV for Cloudflare, filesystem for Node.js
3. **Authentication** - Bearer tokens instead of CLI arguments
4. **Configuration** - Programmatic API instead of command-line flags

### Key Differences

| Feature | CodeWhip CLI | CodeWhip Proxy |
|---------|--------------|----------------|
| Deployment | Node.js process | Cloudflare Workers or Node.js |
| Storage | Filesystem (`.codewhip/`) | KV (Cloudflare) or filesystem (Node.js) |
| Authentication | CLI arguments (`--token`) | Bearer tokens in headers |
| Configuration | Command-line flags | Programmatic API |
| Usage | Terminal commands | Library import |

## Compatibility

### Node.js Support

- **Minimum version**: Node.js 20
- **Module system**: ESM-only
- **TypeScript**: Compiled to ES2022

### Cloudflare Workers Support

- **Runtime**: Cloudflare Workers (JavaScript)
- **Fetch API**: Native Workers fetch API
- **KV**: Cloudflare KV namespace binding

### npm package

- **Entry points**: Multiple exports for different use cases
- **Type definitions**: Full TypeScript support
- **Tree-shaking**: Optimized for bundle size

## License

MIT License. See `LICENSE` file for details.

## Contributing

Contributions are welcome! Please see the contributing guidelines in the repository.

## Contact

For questions, issues, or feedback:

- GitHub Issues: https://github.com/hasitpbhatt/codewhip/issues
- Documentation: https://github.com/hasitpbhatt/codewhip/blob/main/README_PROXY.md

## Version

`0.2.0`

---

*This library is built on the foundation of CodeWhip and extends it for external use. The existing CodeWhip CLI continues to work unchanged.*