(function () {
  function getSafeNextUrl(raw) {
    if (raw == null || typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/pages/")) return null;
    if (trimmed.includes("://") || trimmed.startsWith("//")) return null;
    if (
      /autorization\.html|register\.html|index\.html(?:$|[?#])/i.test(trimmed)
    ) {
      return null;
    }
    return trimmed;
  }

  function getNextFromQuery() {
    try {
      const params = new URL(window.location.href).searchParams;
      return getSafeNextUrl(params.get("next"));
    } catch {
      return null;
    }
  }

  function buildAuthUrl(nextPath, extraParams) {
    const url = new URL("/pages/autorization.html", window.location.origin);
    const next = getSafeNextUrl(nextPath);
    if (next) {
      url.searchParams.set("next", next);
    }
    if (extraParams && typeof extraParams === "object") {
      Object.entries(extraParams).forEach(([key, value]) => {
        if (value != null && String(value).trim() !== "") {
          url.searchParams.set(key, String(value));
        }
      });
    }
    return url.pathname + url.search;
  }

  function buildRegisterUrl(nextPath) {
    const url = new URL("/pages/register.html", window.location.origin);
    const next = getSafeNextUrl(nextPath);
    if (next) {
      url.searchParams.set("next", next);
    }
    return url.pathname + url.search;
  }

  function redirectToAuth(nextPath, extraParams) {
    const fallback =
      window.location.pathname +
      window.location.search +
      window.location.hash;
    window.location.replace(buildAuthUrl(nextPath || fallback, extraParams));
  }

  function resolvePostAuthRedirect(user) {
    const next = getNextFromQuery();
    if (next) return next;
    if (user && Number(user.role_id) === 2) {
      return "/pages/admin.html";
    }
    return "/pages/main.html";
  }

  window.AuthNext = {
    getSafeNextUrl,
    getNextFromQuery,
    buildAuthUrl,
    buildRegisterUrl,
    redirectToAuth,
    resolvePostAuthRedirect,
  };
})();
