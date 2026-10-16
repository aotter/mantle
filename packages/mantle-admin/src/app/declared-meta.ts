/**
 * What `buildAdmin` declared in the built App as `<meta name content='json'>`: its `mcp.csp` (`mantle-mcp-csp`) and what the
 * application customised (`mantle-mcp-app`). Undefined when the file has none.
 */
export function declaredMeta<T>(html: string, name: string): T | undefined {
  const content = new RegExp("<meta name=\"" + name + "\" content='([^']*)'>").exec(html)?.[1];
  return content ? JSON.parse(content) as T : undefined;
}
