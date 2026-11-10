// One error type for anything the client should see. `code` is stable and
// machine-readable; `message` is safe to show a customer.
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { AppError };
