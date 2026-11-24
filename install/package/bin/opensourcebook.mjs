#!/usr/bin/env node
// The `opensourcebook` command. Written so that an old Node can read it and answer with a plain sentence
// instead of a syntax error; everything else lives in ../lib and needs Node 24.
var version = process.env.OPENSOURCEBOOK_PRETEND_NODE || process.versions.node;
if (Number(version.split(".")[0]) < 24) {
  console.error("Open Sourcebook needs Node 24 and this computer has Node " + version + "; the one-line installer at https://opensourcebook.app brings its own.");
  process.exit(1);
} else {
  import("../lib/main.mjs")
    .then(function (lib) {
      return lib.main(process.argv.slice(2));
    })
    .then(
      function (code) {
        process.exitCode = code;
      },
      function (error) {
        console.error(process.env.OPENSOURCEBOOK_DEBUG ? error : "Open Sourcebook ran into a problem: " + (error && error.message ? error.message : String(error)) + " Run the same command again.");
        process.exitCode = 1;
      }
    );
}
