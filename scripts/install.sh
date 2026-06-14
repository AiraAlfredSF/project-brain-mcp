#!/usr/bin/env bash
# code-brain-mcp installer — Spec 07 §6.
#
# Run from the root of the target repo:
#   /path/to/code-brain-mcp/source/scripts/install.sh
# or, once published:
#   npx code-brain-mcp-install
set -euo pipefail

MARKER_START="<!-- code-brain-mcp:start -->"
MARKER_END="<!-- code-brain-mcp:end -->"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$PACKAGE_ROOT/skills"
DIST_ENTRY="$PACKAGE_ROOT/dist/src/index.js"

TARGET_DIR="$(pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Print the lines strictly between the marker comments in $1.
extract_inner() {
  sed -n "/^${MARKER_START}\$/,/^${MARKER_END}\$/p" "$1" | sed '1d;$d'
}

# Install a marker-wrapped rule file ($1 = source, $2 = destination).
# - If the destination doesn't exist, it is created.
# - If the destination already has a code-brain-mcp marker block, that block
#   is replaced in place (preserving surrounding user content).
# - Otherwise, a new marker block is appended.
install_rule_file() {
  local src="$1"
  local dest="$2"

  if [[ ! -f "$dest" ]]; then
    cp "$src" "$dest"
    echo "  created $dest"
    return
  fi

  if grep -qF "$MARKER_START" "$dest"; then
    local tmp inner_file
    tmp="$(mktemp)"
    inner_file="$(mktemp)"
    extract_inner "$src" > "$inner_file"
    awk -v start="$MARKER_START" -v end="$MARKER_END" -v innerfile="$inner_file" '
      $0 == start {
        print
        while ((getline line < innerfile) > 0) print line
        close(innerfile)
        skip=1; next
      }
      $0 == end { print; skip=0; next }
      skip      { next }
      { print }
    ' "$dest" > "$tmp"
    mv "$tmp" "$dest"
    rm -f "$inner_file"
    echo "  updated code-brain-mcp block in $dest"
  else
    {
      echo ""
      cat "$src"
    } >> "$dest"
    echo "  appended code-brain-mcp block to $dest"
  fi
}

# Copy an agent's bootstrap.md into .code-brain/<agent>/bootstrap.md.
install_bootstrap_file() {
  local src="$1"
  local agent="$2"
  local dest_dir="$TARGET_DIR/.code-brain/$agent"
  mkdir -p "$dest_dir"
  cp "$src" "$dest_dir/bootstrap.md"
  echo "  created $dest_dir/bootstrap.md"
}

# Merge a code-brain MCP server entry into a JSON config file.
# $1 = config path, $2 = agent name ("opencode" uses a different shape).
register_mcp_config() {
  local config_path="$1"
  local agent="$2"

  mkdir -p "$(dirname "$config_path")"
  if [[ ! -f "$config_path" ]]; then
    echo '{}' > "$config_path"
  fi

  node -e '
    const fs = require("fs");
    const [configPath, distEntry, agent] = process.argv.slice(1);
    const raw = fs.readFileSync(configPath, "utf8").trim();
    const cfg = raw ? JSON.parse(raw) : {};
    if (agent === "opencode") {
      cfg.mcp = cfg.mcp || {};
      cfg.mcp["code-brain"] = { type: "local", command: ["node", distEntry], enabled: true };
    } else {
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers["code-brain"] = { command: "node", args: [distEntry] };
    }
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  ' "$config_path" "$DIST_ENTRY" "$agent"

  echo "  registered code-brain MCP server in $config_path"
}

# ---------------------------------------------------------------------------
# 1. Detect agents
# ---------------------------------------------------------------------------

detected=()

if [[ -f "$TARGET_DIR/CLAUDE.md" || -d "$TARGET_DIR/.claude" ]]; then
  detected+=("claude-code")
fi
if [[ -f "$TARGET_DIR/.clinerules" || -d "$TARGET_DIR/.cline" ]]; then
  detected+=("cline")
fi
if [[ -f "$TARGET_DIR/.cursorrules" || -d "$TARGET_DIR/.cursor" ]]; then
  detected+=("cursor")
fi
if [[ -f "$TARGET_DIR/AGENTS.md" || -d "$TARGET_DIR/.opencode" ]]; then
  detected+=("opencode")
fi

if [[ ${#detected[@]} -eq 0 ]]; then
  echo "No supported CLI agent detected in $TARGET_DIR." >&2
  echo "" >&2
  echo "Supported agents and their marker files:" >&2
  echo "  - Claude Code: CLAUDE.md or .claude/" >&2
  echo "  - Cline:       .clinerules or .cline/" >&2
  echo "  - Cursor:      .cursorrules or .cursor/" >&2
  echo "  - opencode:    AGENTS.md or .opencode/" >&2
  echo "" >&2
  echo "To install manually, create one of the marker files above and" >&2
  echo "re-run this script, or copy the relevant files from" >&2
  echo "$SKILLS_DIR/<agent>/ into this repo yourself." >&2
  exit 1
fi

echo "Detected agent(s): ${detected[*]}"
echo ""

# ---------------------------------------------------------------------------
# 2-3. Copy skill files + register MCP server, per detected agent
# ---------------------------------------------------------------------------

for agent in "${detected[@]}"; do
  echo "Setting up $agent..."

  case "$agent" in
    claude-code)
      install_rule_file "$SKILLS_DIR/claude-code/CLAUDE.md" "$TARGET_DIR/CLAUDE.md"
      install_bootstrap_file "$SKILLS_DIR/claude-code/bootstrap.md" "claude-code"
      register_mcp_config "$TARGET_DIR/.mcp.json" "claude-code"
      ;;
    cline)
      install_rule_file "$SKILLS_DIR/cline/.clinerules" "$TARGET_DIR/.clinerules"
      install_bootstrap_file "$SKILLS_DIR/cline/bootstrap.md" "cline"
      echo "  Cline stores its MCP server config outside the repo (VS Code"
      echo "  global storage). Add the following server manually via the"
      echo "  Cline 'MCP Servers' panel:"
      echo "    name:    code-brain"
      echo "    command: node"
      echo "    args:    [\"$DIST_ENTRY\"]"
      ;;
    cursor)
      install_rule_file "$SKILLS_DIR/cursor/.cursorrules" "$TARGET_DIR/.cursorrules"
      install_bootstrap_file "$SKILLS_DIR/cursor/bootstrap.md" "cursor"
      register_mcp_config "$TARGET_DIR/.cursor/mcp.json" "cursor"
      ;;
    opencode)
      install_rule_file "$SKILLS_DIR/opencode/AGENTS.md" "$TARGET_DIR/AGENTS.md"
      install_bootstrap_file "$SKILLS_DIR/opencode/bootstrap.md" "opencode"
      register_mcp_config "$TARGET_DIR/opencode.json" "opencode"
      ;;
  esac

  echo ""
done

# ---------------------------------------------------------------------------
# 4. Create .project-brain/
# ---------------------------------------------------------------------------

if [[ -d "$TARGET_DIR/.project-brain" ]]; then
  echo ".project-brain/ already exists — leaving it untouched."
else
  mkdir -p "$TARGET_DIR/.project-brain"
  echo "Created .project-brain/"
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Install post-commit hook (EC-ASP-04)
# ---------------------------------------------------------------------------

HOOK_SRC="$SCRIPT_DIR/hooks/post-commit"
HOOK_DEST="$TARGET_DIR/.git/hooks/post-commit"

if [[ -d "$TARGET_DIR/.git" ]]; then
  if [[ ! -f "$HOOK_DEST" ]]; then
    mkdir -p "$TARGET_DIR/.git/hooks"
    cp "$HOOK_SRC" "$HOOK_DEST"
    chmod +x "$HOOK_DEST"
    echo "Installed post-commit hook at .git/hooks/post-commit"
  elif grep -qF "code-brain-mcp" "$HOOK_DEST"; then
    echo "post-commit hook already has a code-brain-mcp block — leaving it as-is."
  else
    {
      echo ""
      echo "# --- code-brain-mcp post-commit hook (appended by install.sh) ---"
      cat "$HOOK_SRC"
    } >> "$HOOK_DEST"
    chmod +x "$HOOK_DEST"
    echo "Appended code-brain-mcp block to existing .git/hooks/post-commit"
  fi
else
  echo "No .git directory found — skipping post-commit hook install."
fi
echo ""

# ---------------------------------------------------------------------------
# 6. Bootstrap prompt
# ---------------------------------------------------------------------------

cat <<'EOF'
Setup complete.

Next steps (in your agent's next session):
  1. Call start_session()
  2. Call get_bootstrap_status()
     - If it returns "BOOTSTRAP: never_run", call run_bootstrap(path) and
       follow the prompts (see <agent>/bootstrap.md for the full flow).
     - Otherwise, you're ready to go.
EOF
