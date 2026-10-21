#!/bin/sh
set -eu

# Usage: sh install.sh [--dir PATH] [--bin-dir PATH] [--repo URL] [--ref BRANCH]
# Download first when using a version manager: its initialization may read stdin.
install_dir="$HOME/.local/share/perpeto"
bin_dir="$HOME/.local/bin"
repository='https://github.com/jstEagle/Perpeto'
revision='main'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir|--bin-dir|--repo|--ref)
      [ "$#" -ge 2 ] || { echo 'Missing option value.' >&2; exit 1; }
      case "$1" in
        --dir) install_dir=$2 ;; --bin-dir) bin_dir=$2 ;; --repo) repository=$2 ;; --ref) revision=$2 ;;
      esac
      shift 2 ;;
    --help) echo 'Usage: sh install.sh [--dir PATH] [--bin-dir PATH] [--repo URL] [--ref BRANCH]'; exit 0 ;;
    *) echo 'Unknown option.' >&2; exit 1 ;;
  esac
done
case "$(uname -s)" in Darwin|Linux) ;; *) echo 'Perpeto supports macOS and Linux.' >&2; exit 1 ;; esac
case "$revision" in ''|-*) echo '--ref must name a branch.' >&2; exit 1 ;; esac
case "$install_dir:$bin_dir" in *'
'*) echo 'Paths must not contain line breaks.' >&2; exit 1 ;; esac
case "$install_dir" in /*) ;; *) echo '--dir must be an absolute path.' >&2; exit 1 ;; esac
case "$bin_dir" in /*) ;; *) echo '--bin-dir must be an absolute path.' >&2; exit 1 ;; esac
node_ok() {
  command -v node >/dev/null 2>&1 && node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a===24&&(b>13||b===13&&c>=1)?0:1)' >/dev/null 2>&1
}
if ! node_ok; then
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # nvm does not consistently support nounset across versions.
    set +u
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 24
    nvm use 24
    set -u
  elif command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)"
    fnm install 24
    fnm use 24
  elif command -v mise >/dev/null 2>&1; then
    mise install node@24
    eval "$(mise env -s bash node@24)"
  elif command -v asdf >/dev/null 2>&1; then
    asdf install nodejs latest:24
    node_path=$(asdf where nodejs latest:24)
    PATH="$node_path/bin:$PATH"; export PATH
  elif command -v volta >/dev/null 2>&1; then
    volta install node@24
  else
    echo 'Install Node >=24.13.1 <25 with your version manager, select it, then rerun this installer. No system changes made.' >&2
    exit 1
  fi
fi
node_ok || { echo 'Select Node >=24.13.1 <25, then rerun.' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo 'Install git, then rerun.' >&2; exit 1; }
if ! command -v pnpm >/dev/null 2>&1; then
  echo 'Install pnpm 11.10.0 in your user environment (for example: corepack prepare pnpm@11.10.0 --activate), then rerun.' >&2
  exit 1
fi
[ "$(pnpm --version)" = '11.10.0' ] || { echo 'Select pnpm 11.10.0, then rerun.' >&2; exit 1; }
target="$install_dir/apps/cli/bin/perpeto.js"
# Installs made before the apps/ layout link the CLI from packages/perpeto-cli; re-point those.
legacy_target="$install_dir/packages/perpeto-cli/bin/perpeto.js"
link="$bin_dir/perpeto"
relink=''
if [ -e "$link" ] || [ -L "$link" ]; then
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$legacy_target" ]; then relink=1
  else [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ] || { echo 'An unrelated perpeto bin already exists. Choose --bin-dir.' >&2; exit 1; }
  fi
fi
if [ -e "$install_dir" ]; then
  [ -d "$install_dir/.git" ] || { echo 'Install directory is not a standalone Git checkout. Choose an empty path.' >&2; exit 1; }
  [ "$(git -C "$install_dir" remote get-url origin)" = "$repository" ] || { echo 'Existing checkout has a different origin. Refusing to update.' >&2; exit 1; }
  [ -z "$(git -C "$install_dir" status --porcelain --untracked-files=all)" ] || { echo 'Existing checkout has local changes. Preserve them before updating.' >&2; exit 1; }
  [ "$(git -C "$install_dir" branch --show-current)" = "$revision" ] || { echo 'Existing checkout is on another branch. Refusing to switch it.' >&2; exit 1; }
  git -C "$install_dir" fetch origin "$revision"
  # Refuse divergent/local commits and backward movement, even when fast-forward is possible.
  git -C "$install_dir" merge-base --is-ancestor HEAD FETCH_HEAD || { echo 'Checkout diverged from the requested upstream branch.' >&2; exit 1; }
  git -C "$install_dir" merge --ff-only FETCH_HEAD
else
  mkdir -p "$(dirname "$install_dir")"
  git clone --branch "$revision" --single-branch -- "$repository" "$install_dir"
fi
cd "$install_dir"
[ -f "$target" ] || { echo 'This revision does not include the Perpeto CLI.' >&2; exit 1; }
npm run setup
npm run build
mkdir -p "$bin_dir"
if [ ! -L "$link" ]; then ln -s "$target" "$link"; elif [ -n "$relink" ]; then ln -sfn "$target" "$link"; fi
echo "Installed: $link"
echo "Add $bin_dir to PATH, then run: perpeto hub init && perpeto hub start"
