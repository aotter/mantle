import type { EntryReader, PublishedEntryPage, ReadPublishedPageArgs } from "@aotter/mantle-runtime";

interface Cursor {
  readonly version: 1;
  readonly collection: number;
  readonly cursor?: string;
}

export async function readPublishedAcrossCollections(
  reader: EntryReader,
  collections: readonly string[],
  args: Omit<ReadPublishedPageArgs, "collection" | "cursor"> & { readonly cursor?: string },
): Promise<PublishedEntryPage> {
  const decoded = decode(args.cursor);
  const rows = [];
  let index = decoded.collection;
  let cursor = decoded.cursor;
  while (index < collections.length && rows.length < (args.limit ?? 50)) {
    const page = await reader.readPublishedPage({
      ...args,
      collection: collections[index]!,
      cursor,
      limit: (args.limit ?? 50) - rows.length,
    });
    rows.push(...page.rows);
    if (page.nextCursor) {
      return { rows, nextCursor: encode({ version: 1, collection: index, cursor: page.nextCursor }) };
    }
    index += 1;
    cursor = undefined;
  }
  return { rows, nextCursor: index < collections.length ? encode({ version: 1, collection: index }) : undefined };
}

function encode(cursor: Cursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

function decode(value: string | undefined): Cursor {
  if (!value) return { version: 1, collection: 0 };
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<Cursor>;
    if (parsed.version === 1 && Number.isSafeInteger(parsed.collection) && parsed.collection! >= 0 &&
        (parsed.cursor === undefined || typeof parsed.cursor === "string")) return parsed as Cursor;
  } catch {}
  throw new RangeError("invalid published collection cursor");
}
