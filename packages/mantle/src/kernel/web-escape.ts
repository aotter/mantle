/** HTML and XML text escaping, shared by the head tags and the indexes. */
export const escape = (v: unknown) =>
  String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
