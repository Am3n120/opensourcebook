#!/usr/bin/env node
// This file was the command before the product was renamed to Open Sourcebook. It stays so that a copy from before
// the rename can update: that copy's updater is already running when the new files arrive, and it starts the new
// version through this path. An older `npm link` and an installed skill may point here too. It does nothing of its
// own: it passes the same words on to cli/opensourcebook.mjs. It is not listed in package.json's "bin".
await import("./opensourcebook.mjs");
