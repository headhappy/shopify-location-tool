export class BundleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw new BundleError(message, status);
}
export function gid(value, type) {
  requireValue(
    typeof value === "string" &&
      new RegExp(`^gid://shopify/${type}/[1-9][0-9]*$`).test(value),
    `A Shopify ${type} ID is required.`,
  );
  return value;
}
export function integer(value, name, max = 10000) {
  requireValue(
    Number.isSafeInteger(value) && value > 0 && value <= max,
    `${name} must be a whole number from 1 to ${max}.`,
  );
  return value;
}
export function shortText(value, name, max = 160) {
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= max &&
      !/[\x00-\x1f]/.test(value),
    `${name} is required (up to ${max} characters).`,
  );
  return value.trim();
}
