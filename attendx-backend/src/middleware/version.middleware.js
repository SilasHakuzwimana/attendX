const versionMiddleware = (req, res, next) => {
  // Extract version from URL
  const version = req.baseUrl.includes("/v1") ? "v1" : "legacy";

  // Add version to request object
  req.apiVersion = version;

  // Add version headers
  res.setHeader("X-API-Version", version === "v1" ? "1.0" : "legacy");
  res.setHeader("X-API-Deprecated", version === "legacy" ? "true" : "false");

  // Log version usage (optional)
  if (version === "legacy") {
    console.warn(`Legacy API used: ${req.method} ${req.originalUrl}`);
  }

  next();
};

module.exports = { versionMiddleware };
