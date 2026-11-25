// Sends www.opensourcebook.app and plain http to https://opensourcebook.app with a 301,
// keeping the path and query. Every other request is the folder site/ as it is.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.opensourcebook.app" ||
      (url.hostname === "opensourcebook.app" && url.protocol === "http:")) {
      url.protocol = "https:";
      url.hostname = "opensourcebook.app";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
