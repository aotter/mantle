/** HTML and XML text escaping, shared by the head tags, the indexes and the page head formatter. */
export const escape = (v: unknown) =>
  String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
