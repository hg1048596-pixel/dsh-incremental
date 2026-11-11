/** Return a one-based page from an in-memory collection. */
export function paginate(items, page, pageSize) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('page and pageSize must be positive integers');
  }

  const offset = (page - 1) * pageSize;
  return items.slice(offset, pageSize);
}
