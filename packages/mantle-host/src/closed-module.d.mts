/** Throws `backend_handlers_not_closed` unless `text` is one ES module with no imports of any kind. */
export function assertClosedModule(text: string): void
