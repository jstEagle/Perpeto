/** Delivery errors. Kept free of Node built-ins so browser clients can share the queue configuration validator. */
export class DeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.statusCode = code === 'IDEMPOTENCY_CONFLICT' || code === 'BUSY' ? 409 : 400;
  }
  toJSON() { return { error: { code: this.code, message: this.message } }; }
}
