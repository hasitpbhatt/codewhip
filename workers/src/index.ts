export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Import the proxy library dynamically to avoid Node.js dependencies
    const { createProxy, createStorageForBackend } = await import("../src/lib/index.js");
    
    // Create storage using Cloudflare KV
    const storage = createStorageForBackend("kv", env.PROXY_STORAGE);
    
    // Create proxy options
    const proxyOptions = {
      provider: "auto",  // Use auto provider selection
      model: "auto",     // Use auto model selection
      token: env.BEARER_TOKEN, // Optional bearer token for authentication
      authUi: true,      // Enable auth UI
      pingModels: false, // Disable model pinging for performance
      storage,          // Pass the storage instance
    };
    
    // Create proxy instance
    const proxy = createProxy(proxyOptions);
    
    // Handle the request
    return proxy.handle(request);
  },
};