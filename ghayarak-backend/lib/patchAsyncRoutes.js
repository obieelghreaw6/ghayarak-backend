// See lib/asyncHandler.js for the underlying problem this solves. Rather
// than wrapping all ~65 individual route handlers by hand across 9 files
// (high risk of missing one, or introducing a typo mid-edit), this patches
// the well-documented public Router.prototype API once, here, so every
// route defined anywhere in the app gets automatic async-error forwarding.
//
// This only touches Router.prototype.{get,post,put,patch,delete,use} — not
// any internal/undocumented Express modules — so it's stable across Express
// 4.x patch versions. It must be required BEFORE any routes/*.js file,
// since those files call router.get/.post etc. at module-load time and
// need the patched version to already be in place.
const { Router } = require("express");

const METHODS = ["get", "post", "put", "patch", "delete", "use"];

function wrap(handler) {
  if (typeof handler !== "function") return handler;
  // Error-handling middleware has arity 4: (err, req, res, next). Leave it
  // alone — wrapping it would break Express's error-middleware detection,
  // which is based on Function.prototype.length.
  if (handler.length >= 4) return handler;

  return function wrapped(req, res, next) {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.catch === "function") {
        result.catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

METHODS.forEach((method) => {
  const original = Router.prototype[method];
  if (!original) return;
  Router.prototype[method] = function (...args) {
    const wrappedArgs = args.map((arg) => (typeof arg === "function" ? wrap(arg) : arg));
    return original.apply(this, wrappedArgs);
  };
});
