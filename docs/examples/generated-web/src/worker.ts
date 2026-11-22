import { fetchSite, health, type Env } from './app.js';

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    if ((request.method === 'GET' || request.method === 'HEAD') && new URL(request.url).pathname === '/health')
      return health(request.method);
    return fetchSite(request, env);
  }
};
