// Backend defaults. The static-site builder replaces this whole configuration
// artifact in its staging directory; application source is never rewritten.
window.APP_RUNTIME_CONFIG = Object.freeze({
  hasBackend: true,
  apiFileSuffix: "",
});
