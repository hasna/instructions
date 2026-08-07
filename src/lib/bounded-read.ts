import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, parseCursor, parseLimit } from "./compact-output.js";
import type { BoundedReadOptions, BoundedReadPage } from "../types/index.js";

export function normalizeBoundedReadOptions(
  options: BoundedReadOptions = {},
): { limit: number; cursor: number } {
  return {
    limit: parseLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    cursor: parseCursor(options.cursor),
  };
}

export function boundedReadPage<T>(
  items: T[],
  total: number,
  options: BoundedReadOptions = {},
): BoundedReadPage<T> {
  const { limit, cursor } = normalizeBoundedReadOptions(options);
  if (items.length > limit) {
    throw new Error(`bounded read returned ${items.length} rows for limit ${limit}`);
  }
  const consumed = cursor + items.length;
  const complete = consumed >= total;
  if (!complete && items.length === 0) {
    throw new Error(`bounded read did not advance at cursor ${cursor} of ${total}`);
  }
  return {
    items,
    total,
    limit,
    cursor,
    next_cursor: complete ? null : consumed,
    has_more: !complete,
    complete,
    truncated: false,
  };
}
