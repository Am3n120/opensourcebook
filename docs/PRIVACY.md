# What leaves your computer

Open Sourcebook keeps your files, your projects and everything it makes on your computer, and it has no server that receives them. Your agent is the part that reaches out: to do its work it sends what it reads from your sources to its own provider, as it does whenever you use it. In full, what leaves:

- what your own agent sends to its own provider as it works (Anthropic for Claude Code, OpenAI for Codex, OpenCode's own hosted models when you use OpenCode's free models without an account, Google for Antigravity, Cursor for Cursor's agent, GitHub for GitHub Copilot);
- the requests Open Sourcebook makes to read what your sources point at: a link source's page and the pictures and files in it, and, if you set its key, the reader service `r.jina.ai` (`JINA_API_KEY`);
- the video agent's web searches and the pages, pictures, archives and videos it opens while it makes a video, and its calls to Meta's API if you set `META_API_KEY`;
- the text of a video's or an audio's narration if you add an ElevenLabs or a Speechify key (Kokoro sends nothing: it downloads its model from Hugging Face once, when you install it, and then runs on your computer);
- in a clone, at each start, one question to the place you cloned from: which is the newest commit, so Open Sourcebook can say when a newer version is out. `OPENSOURCEBOOK_UPDATE_CHECK=0` turns it off. An update downloads the new version from GitHub.

Only public addresses are opened that way, never this computer or your own network (see [`SECURITY.md`](../SECURITY.md) for how, and its one limit in the engine).
