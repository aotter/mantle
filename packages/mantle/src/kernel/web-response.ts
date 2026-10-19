/** Response hashing is needed only when a Web route actually renders. */
export async function webResponse(request: Request, body: string, type: string, cacheControl: string): Promise<Response> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const etag = '"' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('') + '"';
  const headers = {'content-type':type+'; charset=utf-8','cache-control':cacheControl,etag};
  const cached = request.headers.get('if-none-match')?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//,'') === etag);
  return new Response(cached || request.method === 'HEAD' ? null : body,{status:cached?304:200,headers});
}
