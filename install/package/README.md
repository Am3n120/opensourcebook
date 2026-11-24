# Open Sourcebook

Open Sourcebook is an open-source app that runs on your own computer: you drop in what you have to read (a course, a stack of papers, a manual, a report), and it makes cited answers, quizzes, flashcards, audio and short explainer videos from it, to help you understand it and explain it to others.

This package puts Open Sourcebook in one folder in your home folder (`.opensourcebook`), adds a shortcut, and starts it. The easiest way to get it is the one line at [opensourcebook.app](https://opensourcebook.app), which also brings Node 24 if your computer does not have it.

If you already have Node 24, this one line does the same:

```
npx opensourcebook@latest install
```

Afterwards `opensourcebook` opens it, `opensourcebook stop` stops it, and `opensourcebook update` gets the newest version. Your projects stay in that one folder and nothing else on your computer is changed.
