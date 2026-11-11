const { randomBytes, timingSafeEqual } = require("node:crypto");

function createToken() {
  return randomBytes(32).toString("hex");
}
function isTrustedUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
function authorized(request, token) {
  const received = request.headers["x-tracefolio-desktop"];
  return (
    typeof received === "string" &&
    received.length === token.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(token))
  );
}
module.exports = { createToken, isTrustedUrl, authorized };
