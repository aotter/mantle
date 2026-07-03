/** Kebab/snake/camelCase identifier → "Title Case" label. Shared copy
 *  used for Schema property names, Procedure names, and View names
 *  across `authenticated-layout.tsx`, `collection-view.tsx`,
 *  `entry-edit-view.tsx`, `view-page.tsx`, and `operations-view.tsx` —
 *  extracted (#430) once a 4th/5th call site needed the identical
 *  regex pair. */
export function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
