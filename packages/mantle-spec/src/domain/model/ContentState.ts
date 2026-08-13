/** Persisted publishing state for content entries. */
export const ContentState = {
  Draft: "draft",
  Published: "published",
  Archived: "archived",
} as const;
export type ContentState = (typeof ContentState)[keyof typeof ContentState];
