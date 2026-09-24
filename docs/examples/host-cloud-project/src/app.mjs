export const handlers = { ping: () => ({ ok: true }) };

export default {
  fetch(request) {
    if (new URL(request.url).pathname !== '/') return new Response('Not found', { status: 404 });
    return new Response('<!doctype html><html><head><title>Notes</title></head><body><h1>Notes</h1></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};
