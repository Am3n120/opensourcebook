#!/bin/sh
# Tries install/site/install for real, in a throwaway home folder.
#
#   sh install/test/script.sh              the quick cases, no internet needed
#   sh install/test/script.sh --download   also downloads a real Node (about 50 MB)
#
# It never touches the real home folder: every run gets HOME=<throwaway>/...
# It runs a stand-in package, made here, in place of the real opensourcebook
# package; the stand-in prints what it was given and writes the command file.
# Needs node and npm (to pack the stand-in). The cases that need a computer
# without Node are skipped when /usr/bin or /bin holds a node.

set -u

here=$(cd "$(dirname "$0")" && pwd)
installer=$here/../site/install
download=no
[ "${1:-}" = --download ] && download=yes

root=$(mktemp -d "${TMPDIR:-/tmp}/opensourcebook-test.XXXXXX")
root=$(cd "$root" && pwd -P)
trap 'rm -rf "$root"' EXIT
passed=0
failed=0
out=$root/out.txt
marker='# Open Sourcebook command'

ok() {
  passed=$((passed + 1))
  printf 'ok    %s\n' "$1"
}

bad() {
  failed=$((failed + 1))
  printf 'FAIL  %s\n' "$1"
  sed 's/^/        /' "$out"
}

# check <name> <what must be true, as a shell test>
check() {
  if eval "$2"; then ok "$1"; else bad "$1"; fi
}

has() {
  grep -qF -- "$1" "$out"
}

count() {
  if [ -f "$2" ]; then grep -cF -- "$1" "$2"; else echo 0; fi
}

# The stand-in package.
mkdir -p "$root/stub/bin"
cat >"$root/stub/package.json" <<'EOF'
{ "name": "opensourcebook", "version": "0.0.1", "bin": { "opensourcebook": "bin/opensourcebook.mjs" } }
EOF
cat >"$root/stub/bin/opensourcebook.mjs" <<'EOF'
#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const home = process.env.OPENSOURCEBOOK_HOME
let given = 0
try { given = fs.readFileSync(0).length } catch {}
console.log('STUB args=' + process.argv.slice(2).join(','))
console.log('STUB node=' + process.execPath)
console.log('STUB stdin=' + given)
console.log('STUB archive=' + (process.env.OPENSOURCEBOOK_ARCHIVE || ''))
if (process.argv.includes('--boom')) process.exit(3)
fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
fs.writeFileSync(path.join(home, 'bin', 'opensourcebook'), '#!/bin/sh\necho shim\n', { mode: 0o755 })
EOF
(cd "$root/stub" && npm pack --silent >/dev/null) || {
  echo 'The stand-in package could not be packed; node and npm are needed.'
  exit 1
}
tgz=$root/stub/opensourcebook-0.0.1.tgz

# A pretend Node download site whose files are not what the list says they are.
mkdir -p "$root/dist"
for build in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  echo 'not a real download' >"$root/dist/node-v24.0.0-$build.tar.gz"
  echo "0000000000000000000000000000000000000000000000000000000000000000  node-v24.0.0-$build.tar.gz"
done >"$root/dist/SHASUMS256.txt"

# settings='NAME=value ...' run <home name> <shell to run under> [installer words...]
# The settings hold for that one run only.
run() {
  h=$root/$1
  shell=$2
  shift 2
  mkdir -p "$h"
  (
    eval "$settings"
    HOME=$h
    : "${OPENSOURCEBOOK_PACKAGE:=$tgz}"
    export HOME PATH SHELL OPENSOURCEBOOK_PACKAGE
    for name in OPENSOURCEBOOK_HOME OPENSOURCEBOOK_NO_PATH OPENSOURCEBOOK_NODE_DIST OPENSOURCEBOOK_ARCHIVE; do
      eval "[ -z \"\${$name+set}\" ] || export $name"
    done
    "$shell" "$installer" "$@" >"$out" 2>&1
    echo $? >"$root/code"
  )
  code=$(cat "$root/code")
}

for shell in /bin/sh /bin/dash; do
  [ -x "$shell" ] || continue
  "$shell" -n "$installer" >"$out" 2>&1
  check "$shell reads the script without complaint" '[ $? -eq 0 ]'
done

# Node already on PATH: nothing is downloaded, the words are handed on.
settings='SHELL=/bin/zsh OPENSOURCEBOOK_ARCHIVE=/some/where.tar.gz' run a /bin/sh --no-open --ports-from 9300
check 'Node on PATH: ends well' '[ $code -eq 0 ]'
check 'Node on PATH: says what it will do first' 'has "This is what will happen" && has "not asked for a password"'
check 'Node on PATH: uses it, downloads nothing' 'has "Using the Node already on this computer" && [ ! -e "$root/a/.opensourcebook/node" ]'
check 'Node on PATH: words and archive setting are handed on' 'has "STUB args=install,--no-open,--ports-from,9300" && has "STUB archive=/some/where.tar.gz"'
check 'Node on PATH: the package gets no standard input' 'has "STUB stdin=0"'
check 'Node on PATH: says it is running and how to remove it' 'has "Open Sourcebook is running." && has "To remove it, delete the folder"'
check 'zsh: one line in .zprofile, and it says so' '[ "$(count "$marker" "$root/a/.zprofile")" = 1 ] && has ".zprofile" && has "new terminal window"'
settings='SHELL=/bin/zsh' run a /bin/sh --no-open
check 'zsh, second run: ends well, still one line' '[ $code -eq 0 ] && [ "$(count "$marker" "$root/a/.zprofile")" = 1 ]'
(HOME=$root/a zsh -lc 'command -v opensourcebook' 2>/dev/null || true) >"$out"
if command -v zsh >/dev/null 2>&1; then
  check 'zsh: a new login shell finds the command' 'has "$root/a/.opensourcebook/bin/opensourcebook"'
fi

# bash, with and without a .bash_profile.
settings='SHELL=/bin/bash' run b /bin/sh --no-open
settings='SHELL=/bin/bash' run b /bin/sh --no-open
check 'bash: one line each in .bashrc and .profile' '[ "$(count "$marker" "$root/b/.bashrc")" = 1 ] && [ "$(count "$marker" "$root/b/.profile")" = 1 ] && [ ! -e "$root/b/.bash_profile" ]'
mkdir -p "$root/c" && printf 'export KEEP=1' >"$root/c/.bash_profile"
settings='SHELL=/bin/bash' run c /bin/sh --no-open
settings='SHELL=/bin/bash' run c /bin/sh --no-open
check 'bash with .bash_profile: line goes there once, old text kept, .profile not made' '[ "$(count "$marker" "$root/c/.bash_profile")" = 1 ] && [ "$(count "export KEEP=1" "$root/c/.bash_profile")" = 1 ] && [ "$(wc -l <"$root/c/.bash_profile")" -eq 2 ] && [ ! -e "$root/c/.profile" ]'

# fish, another shell, a known personal folder, and the switch that skips it all.
settings='SHELL=/usr/local/bin/fish' run d /bin/sh --no-open
settings='SHELL=/usr/local/bin/fish' run d /bin/sh --no-open
check 'fish: one line in conf.d/opensourcebook.fish' '[ "$(count "$marker" "$root/d/.config/fish/conf.d/opensourcebook.fish")" = 1 ]'
settings='SHELL=/bin/ksh' run e /bin/sh --no-open
check 'another shell: one line in .profile' '[ "$(count "$marker" "$root/e/.profile")" = 1 ]'
settings='PATH=$root/f/.local/bin:$PATH SHELL=/bin/zsh' run f /bin/sh --no-open
settings='PATH=$root/f/.local/bin:$PATH SHELL=/bin/zsh' run f /bin/sh --no-open
check '~/.local/bin on PATH: a link, and no profile file' '[ -L "$root/f/.local/bin/opensourcebook" ] && [ "$("$root/f/.local/bin/opensourcebook")" = shim ] && [ ! -e "$root/f/.zprofile" ]'
settings='OPENSOURCEBOOK_NO_PATH=1 SHELL=/bin/zsh' run g /bin/sh --no-open
check 'OPENSOURCEBOOK_NO_PATH=1: ends well, nothing outside the folder' '[ $code -eq 0 ] && [ ! -e "$root/g/.zprofile" ] && [ ! -e "$root/g/.local" ]'
settings='SHELL=/bin/zsh OPENSOURCEBOOK_HOME=$root/h/elsewhere' run h /bin/sh --no-start
check 'another home folder, --no-start: line names it, says installed' 'grep -qF "$root/h/elsewhere/bin" "$root/h/.zprofile" && has "Open Sourcebook is installed." && [ ! -e "$root/h/.opensourcebook" ]'

# The package itself fails.
settings='SHELL=/bin/zsh' run i /bin/sh --boom
check 'the package fails: one sentence, a next step, not zero, no PATH line' '[ $code -ne 0 ] && has "could not finish setting up" && has "Next step:" && [ ! -e "$root/i/.zprofile" ]'

# Piped, the way curl hands it over.
for shell in /bin/sh /bin/dash; do
  [ -x "$shell" ] || continue
  mkdir -p "$root/p"
  HOME=$root/p SHELL=/bin/zsh OPENSOURCEBOOK_PACKAGE=$tgz "$shell" -s -- --no-open <"$installer" >"$out" 2>&1
  code=$?
  check "piped into $shell: ends well, words handed on, runs to the end" '[ $code -eq 0 ] && has "STUB args=install,--no-open" && has "STUB stdin=0" && has "To remove it"'
done
mkdir -p "$root/q"
size=$(wc -c <"$installer")
head -c $((size - 12)) "$installer" | HOME=$root/q SHELL=/bin/zsh OPENSOURCEBOOK_PACKAGE=$tgz /bin/sh >"$out" 2>&1
check 'a download cut off before the end runs nothing' '[ ! -e "$root/q/.opensourcebook" ] && ! has "STUB"'

# From here on: a computer without Node.
if [ -x /usr/bin/node ] || [ -x /bin/node ]; then
  echo 'skip  the cases without Node: /usr/bin or /bin holds a node'
else
  bare=/usr/bin:/bin

  settings='PATH=$bare SHELL=/bin/zsh OPENSOURCEBOOK_NODE_DIST=file://$root/nowhere' run n1 /bin/sh --no-open
  check 'download site missing: one sentence, a next step, not zero' '[ $code -ne 0 ] && has "could not be read" && has "Next step:" && ! has "STUB"'
  check 'download site missing: nothing left behind' '[ -z "$(ls -A "$root/n1/.opensourcebook")" ] && [ ! -e "$root/n1/.zprofile" ]'

  settings='PATH=$bare SHELL=/bin/zsh OPENSOURCEBOOK_NODE_DIST=file://$root/dist' run n2 /bin/sh --no-open
  check 'damaged download: checksum sentence, not zero, nothing kept' '[ $code -ne 0 ] && has "did not arrive whole" && has "Next step:" && ! has "STUB" && [ -z "$(ls -A "$root/n2/.opensourcebook")" ]'

  # What each kind of computer is given: a pretend uname in front of the real one.
  kind() {
    fake=$root/fake-$1-$2
    mkdir -p "$fake"
    printf '#!/bin/sh\ncase ${1:-} in -m) echo %s ;; *) echo %s ;; esac\n' "$2" "$1" >"$fake/uname"
    chmod +x "$fake/uname"
    settings='PATH=$fake:$bare SHELL=/bin/zsh OPENSOURCEBOOK_NODE_DIST=file://$root/dist' run n3 /bin/sh --no-open
    want=$3
    check "$1 $2: $3" '[ $code -ne 0 ] && has "$want"'
  }
  kind Linux x86_64 'Downloading node-v24.0.0-linux-x64.tar.gz'
  kind Linux aarch64 'Downloading node-v24.0.0-linux-arm64.tar.gz'
  kind Darwin x86_64 'Downloading node-v24.0.0-darwin-x64.tar.gz'
  kind Darwin arm64 'Downloading node-v24.0.0-darwin-arm64.tar.gz'
  kind Linux armv7l 'Install Node 24 from https://nodejs.org'
  kind Linux i686 'Install Node 24 from https://nodejs.org'
  kind FreeBSD amd64 'Install Node 24 from https://nodejs.org'
  printf '#!/bin/sh\necho "musl libc (x86_64)" >&2\nexit 1\n' >"$root/fake-Linux-x86_64/ldd"
  chmod +x "$root/fake-Linux-x86_64/ldd"
  kind Linux x86_64 'Alpine'
  check 'unsupported: says it once, with one next step' '[ "$(count "Next step:" "$out")" = 1 ] && ! has "stopped while"'

  if [ "$download" = yes ]; then
    settings='PATH=$bare SHELL=/bin/zsh OPENSOURCEBOOK_NODE_DIST=https://nodejs.org/dist/no-such-folder' run n4 /bin/sh --no-open
    check 'real site, wrong folder: one sentence, not zero' '[ $code -ne 0 ] && has "could not be read"'
    settings='PATH=$bare SHELL=/bin/zsh' run n5 /bin/sh --no-open
    check 'no Node: a real one is downloaded, checked and used' '[ $code -eq 0 ] && has "The download arrived whole." && has "STUB node=$root/n5/.opensourcebook/node/bin/node" && [ ! -e "$root/n5/.opensourcebook/.install-download.$$" ]'
    check 'no Node: no download folder left behind' '! ls -d "$root"/n5/.opensourcebook/.install-download.* >/dev/null 2>&1'
    settings='PATH=$bare SHELL=/bin/zsh' run n5 /bin/dash --no-open
    check 'second run: the private Node is used again, no download' '[ $code -eq 0 ] && has "Using the private copy of Node" && ! has "Downloading" && has "STUB node=$root/n5/.opensourcebook/node/bin/node"'
    HOME=$root/n5 PATH=$bare SHELL=/bin/zsh OPENSOURCEBOOK_PACKAGE=$tgz /bin/dash -s -- --no-open <"$installer" >"$out" 2>&1
    check 'piped, private Node: ends well' '[ $? -eq 0 ] && has "STUB node=$root/n5/.opensourcebook/node/bin/node" && has "To remove it"'
  else
    echo 'skip  the real Node download: run again with --download'
  fi
fi

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
