#!/bin/bash
# MovieBox-TUI binary download karna (agar nahi hai to)
if [ ! -f "./moviebox-tui" ]; then
    echo "Downloading MovieBox-TUI..."
    wget -qO moviebox.tar.gz https://github.com/mesamirh/MovieBox-Tui/releases/latest/download/moviebox-tui-linux-amd64.tar.gz
    tar -xzf moviebox.tar.gz
    rm moviebox.tar.gz
    chmod +x moviebox-tui
fi

# ttyd ke through TUI ko browser par host karna (Port 8081)
echo "Starting MovieBox-TUI Web Interface..."
ttyd -p 8081 -W ./moviebox-tui
