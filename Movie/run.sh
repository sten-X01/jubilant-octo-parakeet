#!/bin/bash

# 1. Clone the MovieBox-Web repository (if not already there)
if [ ! -d "MovieBox-Web" ]; then
    git clone https://github.com/ifallertzia/ifallhub.git MovieBox-Web
fi
cd MovieBox-Web

# 2. Start the Rust Backend API (Port 8787)
# This handles the scraping, subtitles, and stream resolution
cargo run --release -- --web-api &

# 3. Start the Web Frontend (Port 8081)
cd web
npm install

# Provide the API URL so the frontend knows where to get data
export MOVIEBOX_API_URL=http://127.0.0.1:8787
npm run dev -- -p 8081
