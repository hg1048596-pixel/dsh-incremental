/** Calculate the charge for a line of items in the checkout basket. */
export function calculateLineTotal(unitPrice, quantity) {
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new RangeError('unitPrice must be nonnegative');
  }
  if (!Number.isInteger(quantity)) {
    throw new RangeError('quantity must be a nonnegative integer');
  }

  return Math.round(unitPrice * quantity * 100) / 100;
}
