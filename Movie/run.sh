#!/bin/bash

# 1. Official installation (Jo tumne terminal me test kiya aur working hai)
echo "Installing MovieBox-TUI via official script..."
curl -sSL https://raw.githubusercontent.com/mesamirh/MovieBox-Tui/main/install.sh | bash

# 2. PATH fix (Kyunki install script binary ko ~/.local/bin ya /usr/local/bin me daalta hai)
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

# 3. Terminal UI ke liye proper environment variables set karna
export TERM=xterm-256color
export COLORTERM=truecolor

# 4. ttyd ko bash wrapper ke through start karna taaki app crash na ho
echo "Starting MovieBox-TUI Web Interface on Port 8081..."
ttyd -p 8081 -W bash -c "moviebox-tui"
